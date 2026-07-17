# 外部 API

NetNexus 外部 API 是本机只读 HTTP 服务。当前只注册 BMP 查询接口。

外部 API 不负责启动 BMP。BMP 仍由 BMP 页面启动，API 只查询当前 worker 内存中的实时数据。

## 服务配置

在设置窗口进入「外部API」。

| 配置项 | 默认值 | 范围/格式 | 说明 |
| --- | --- | --- | --- |
| 启用API服务 | `false` | `true` / `false` | 保存后立即启动或停止外部 API 服务 |
| 监听地址 | `127.0.0.1` | 固定值 | 仅允许本机访问，不支持 `0.0.0.0` 等全局监听 |
| 监听端口 | `18080` | 整数 `1..65535` | API HTTP 服务端口 |
| 分页最大条数 | `1000` | 整数 `1..10000` | 限制路由分页接口的 `pageSize` 最大值 |

## 本地 mock 数据

如需在没有真实 BMP 对接的情况下验证页面布局或 API 返回，可以先在 BMP 页面启动服务，再运行：

```bash
npm run mock:bmp
```

常用参数：

```bash
node scripts/mockBmpClient.js --host 127.0.0.1 --port 11019 --routes 25 --interval 30 --once
```

mock 脚本发送 BMPv4 draft-20 TLV 格式。BMP 页面里的 `v4 TLV格式` 需要与之保持一致，否则 Route Monitoring 可能无法解析出 `BGP Message TLV`。

会话 Statistics Report 会在同一帧中上报 Pre/Post Adj-RIB-In/Out 四个阶段。当 `--routes=N` 时，四类全局统计值分别为 `N` / `max(0,N-1)` / `N+2` / `N+1`，并同时携带 IPv4 Unicast 的 per-AFI/SAFI 统计。Loc-RIB Statistics Report 覆盖 RD `0:0`、`65000:100`、`65000:120` 和 `65000:102`；其中 `65000:102` 同时上报 IPv4 Unicast 与 IPv4 Labeled Unicast。

## 通用规则

| 项目 | 规则 |
| --- | --- |
| 协议 | HTTP |
| 监听地址 | 固定 `127.0.0.1`，不允许全局监听 |
| 数据格式 | JSON |
| GET 请求体 | 忽略 |
| POST 请求头 | 建议 `Content-Type: application/json` |
| 请求体大小 | 最大 64KB |
| 字符串处理 | 会 `trim`；控制字符会被拒绝 |
| 未启动 BMP | BMP 查询接口返回 HTTP `409`，错误码 `BMP_NOT_RUNNING` |

## 响应格式

成功响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 固定为 `success` |
| `msg` | string | 描述信息 |
| `data` | any | 接口数据 |

```json
{
  "status": "success",
  "msg": "获取BMP状态成功",
  "data": {
    "running": true
  }
}
```

错误响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 固定为 `error` |
| `code` | string | 机器可读错误码 |
| `msg` | string | 错误描述 |
| `data` | any | 附加错误数据，通常为 `null` |

```json
{
  "status": "error",
  "code": "INVALID_PARAMETER",
  "msg": "pageSize必须是1到1000之间的整数",
  "data": null
}
```

## 错误码

| HTTP 状态码 | code | 说明 |
| --- | --- | --- |
| `400` | `INVALID_JSON` | 请求体不是合法 JSON |
| `400` | `INVALID_PARAMETER` | 参数校验失败 |
| `400` | `BMP_QUERY_FAILED` | BMP 查询失败 |
| `404` | `ROUTE_NOT_FOUND` | 接口不存在 |
| `405` | `METHOD_NOT_ALLOWED` | 请求方法不支持 |
| `409` | `BMP_NOT_RUNNING` | BMP 未启动 |
| `413` | `REQUEST_TOO_LARGE` | 请求体超过 64KB |
| `500` | `INTERNAL_ERROR` | 服务内部错误 |

## 通用对象

下面的对象分为两种用途：

- **请求最小字段**：接口实际校验和读取的字段，只要传这些字段即可。
- **返回扩展字段**：查询接口返回的完整对象字段，可以原样传给后续接口；多余字段会被忽略。

### Client 对象

`client` 建议直接使用 `GET /api/v1/bmp/clients` 返回对象中的连接字段。

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |

最小请求示例：

```json
{
  "client": {
    "localIp": "127.0.0.1",
    "localPort": 11019,
    "remoteIp": "127.0.0.1",
    "remotePort": 50000
  }
}
```

### Session 对象

`session` 建议直接使用 `POST /api/v1/bmp/sessions` 返回对象中的关键字段。

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `sessionType` | integer | 是 | `0..255` | BMP peer type；常见 `0` Global、`1` L3VPN、`2` Local |
| `sessionRd` | string | 是 | 1..128 字符，不能包含控制字符 | RD |
| `sessionIp` | string | 是 | 1..128 字符，不能包含控制字符 | 被监控 BGP peer 地址 |
| `sessionAs` | integer | 是 | `0..4294967295` | 被监控 BGP peer AS |

最小请求示例：

```json
{
  "session": {
    "sessionType": 0,
    "sessionRd": "0:0",
    "sessionIp": "192.0.2.1",
    "sessionAs": 65001
  }
}
```

### Instance 对象

`instance` 建议直接使用 `POST /api/v1/bmp/instances` 返回对象中的关键字段。

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `instanceType` | integer | 是 | `0..255` | BMP instance peer type；Loc-RIB 常见为 `3` |
| `instanceRd` | string | 是 | 1..128 字符，不能包含控制字符 | RD |
| `addrFamilyType` | integer | 是 | 见地址族枚举 | Loc-RIB instance 地址族 |

最小请求示例：

```json
{
  "instance": {
    "instanceType": 3,
    "instanceRd": "0:0",
    "addrFamilyType": 1
  }
}
```

### 分页过滤参数

| 字段 | 类型 | 必填 | 默认值 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `page` | integer | 否 | `1` | `1..1000000` | 页码，从 1 开始 |
| `pageSize` | integer | 否 | `20` | `1..设置页分页最大条数` | 每页条数 |
| `routeState` | string | 否 | `active` | `active`、`stale`、`all` | 路由状态过滤 |
| `prefixFilter` | string | 否 | 空 | 最大 128 字符，不能包含控制字符 | Prefix 或 Prefix/Mask 过滤 |

### 地址族枚举

| 值 | 名称 |
| --- | --- |
| `1` | IPv4 UNC |
| `2` | IPv6 UNC |
| `3` | L2VPN EVPN |
| `4` | VPNV4 |
| `5` | VPNV6 |
| `6` | IPv4 MVPN |
| `7` | IPv6 MVPN |
| `8` | IPv4 QP |
| `9` | IPv6 QP |
| `10` | IPv4 FlowSpec |
| `11` | IPv6 FlowSpec |
| `12` | IPv4 Label |
| `13` | IPv6 Label |
| `14` | Link-State |
| `15` | Link-State VPN |

### RIB 类型枚举

| 值 | 名称 |
| --- | --- |
| `1` | Pre Adj RIB In |
| `2` | Adj RIB In |
| `3` | AS Path |
| `4` | Adj RIB Out |
| `5` | Post Adj RIB Out |

### Route List Item

路由列表接口的 `data.list[]` 元素。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `routeKey` | string | 路由详情查询 key，opaque 字符串，必须原样使用列表接口返回值 |
| `addrFamilyType` | integer/null | 地址族枚举值 |
| `afi` | integer/null | BGP AFI |
| `safi` | integer/null | BGP SAFI |
| `ip` | string/null | 路由前缀 |
| `mask` | integer/null | 掩码长度 |
| `rd` | string/null | RD |
| `origin` | string/number/null | Origin 属性 |
| `asPath` | string/null | AS Path |
| `med` | number | MED |
| `nextHop` | string/null | Next Hop |
| `pathId` | number/string/null | ADD-PATH path id |
| `labels` | string/null | MPLS label 文本 |
| `parserValid` | boolean | NLRI 解析是否有效 |
| `parseErrors` | string/null | 解析错误 |
| `parseWarnings` | string/null | 解析警告 |
| `pathStatus` | number/null | BMPv4 Path Marking 状态位 |
| `pathStatusNames` | array | 已识别 Path Status 名称 |
| `pathStatusText` | string/null | Path Status 文本 |
| `pathStatusUnknownBits` | number | 未识别 Path Status 位 |
| `pathStatusReason` | number/null | Path Status reason code |
| `pathStatusReasonName` | string/null | reason 名称 |
| `pathStatusReasonText` | string/null | reason 文本 |
| `routeState` | string | `active` 或 `stale` |

`routeKey` 只用于精确查询，不支持前缀匹配。不要按 `pathId|rd|ip|mask` 自行解析或拼接；IPv4/IPv6/VPN/EVPN 等地址族都会把真实 NLRI 展示文本放进同一个 key 中，EVPN 可能出现 `evpn:mac-ip:...`、`evpn:ip-prefix:...`、`evpn:leaf-ad:...` 这类可变字符串。调用详情接口时应直接传列表返回的完整 `routeKey`。

### Route Detail

路由详情接口返回 `Route List Item` 的全部字段，并额外包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `localPref` | number | Local Preference |
| `communities` | string/null | Community 文本 |
| `otc` | number/string/null | OTC 属性 |
| `routeType` | string/null | 路由类型，依地址族而定 |
| `rawNlri` | string/null | 原始 NLRI |
| `nlriDetail` | object/null | NLRI 解析详情 |
| `pathStatusReasons` | array | Path Marking reason 列表 |
| `pathStatusTlvs` | array | Path Marking TLV 解析结果 |
| `ribEpoch` | number | RIB 刷新 epoch |
| `staleEpoch` | number/null | 进入 stale 的 epoch |
| `lastSeenAt` | string/null | 最后一次看到该路由的 ISO 时间 |
| `staleAt` | string/null | 标记 stale 的 ISO 时间 |
| `staleReason` | string/null | stale 原因 |
| `summary` | string/null | BGP 报文解析摘要 |

### Statistics Item

统计报表中的 `statistics[]` 元素。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | integer | BMP statistics type |
| `value` | number/string | 统计值；超过 JS 安全整数时返回字符串 |
| `valueHex` | string | 原始统计值十六进制 |
| `afi` | integer/null | 按 AFI/SAFI 统计时有值 |
| `safi` | integer/null | 按 AFI/SAFI 统计时有值 |
| `typeName` | string | 统计类型名称 |

### TLV Item

多处返回中的 `rawTlvs`、`peerUpTlvs`、`tlvs` 等 TLV 数组元素。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | integer | TLV type，去除 enterprise bit 后的值 |
| `rawType` | integer | 原始 TLV type |
| `length` | integer | TLV length |
| `enterprise` | boolean | 是否为 enterprise TLV |
| `enterpriseNumber` | integer/null | enterprise number |
| `valueHex` | string | value 十六进制 |
| `rawValueHex` | string | raw value 十六进制 |
| `index` | integer | BMPv4 indexed TLV 时存在 |
| `rawIndex` | integer | BMPv4 indexed TLV 时存在 |
| `group` | boolean | BMPv4 indexed TLV 时存在 |
| `name` | string | 已识别名称，可能不存在 |
| `value` | string | 文本 TLV 解码值，可能不存在 |
| `decoded` | object | 结构化解码结果，可能不存在 |

## 接口清单

### GET `/api/v1/status`

查询外部 API 服务状态和已注册模块。

请求参数：无。

返回 `data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `running` | boolean | API server 是否运行 |
| `enabled` | boolean | 设置中是否启用 |
| `host` | string | 当前监听地址 |
| `port` | integer | 当前监听端口 |
| `modules` | string[] | 已注册模块，目前包含 `bmp` |

### GET `/api/v1/bmp/status`

查询 BMP 是否启动。

请求参数：无。

返回 `data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `running` | boolean | BMP worker 是否运行 |

### GET `/api/v1/bmp/clients`

查询 BMP 客户端列表。

请求参数：无。

返回 `data`：Client 扩展对象数组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `localIp` | string | NetNexus 本地监听地址 |
| `localPort` | integer | NetNexus 本地监听端口 |
| `remoteIp` | string | BMP 客户端地址 |
| `remotePort` | integer | BMP 客户端端口 |
| `sysName` | string/null | Initiation TLV sysName |
| `sysDesc` | string/null | Initiation TLV sysDesc |
| `bmpVersion` | integer/null | BMP 版本 |
| `bmpV4TlvDraft` | integer | BMPv4 TLV draft，`19` 或 `20` |
| `rawTlvs` | TLV Item[] | Initiation TLV |
| `terminationTlvs` | TLV Item[] | Termination TLV |
| `receivedAt` | string/null | Initiation 接收时间 |

示例：

```bash
curl http://127.0.0.1:18080/api/v1/bmp/clients
```

### POST `/api/v1/bmp/sessions`

查询指定 BMP 客户端下的 BGP session。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |

返回 `data`：Session 扩展对象数组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionType` | integer | BMP peer type |
| `sessionFlags` | integer/null | 生效后的 peer flags |
| `rawSessionFlags` | integer/null | 原始 peer flags |
| `sessionRd` | string | RD |
| `sessionIp` | string | 被监控 BGP peer 地址 |
| `sessionAs` | integer | 被监控 BGP peer AS |
| `sessionRouterId` | string/null | Router ID |
| `sessionTimestamp` | integer/null | BMP peer header timestamp 秒 |
| `sessionTimestampMs` | integer/null | BMP peer header timestamp 微秒 |
| `localIp` | string/null | 被监控 BGP session 本地地址 |
| `localPort` | integer/null | 被监控 BGP session 本地端口 |
| `remotePort` | integer/null | 被监控 BGP session 远端端口 |
| `sessionState` | integer/null | `0` Peer Up，`1` Peer Down |
| `recvAddressFamilies` | array | 收到的能力地址族 |
| `sendAddressFamilies` | array | 发送的能力地址族 |
| `enabledAddressFamilies` | array | 双方共同启用的地址族 |
| `enabledAddrFamilyTypes` | integer[] | 地址族枚举值 |
| `ribTypes` | integer[] | 支持的 RIB 类型枚举 |
| `recvAddPathMap` | object | 收到的 ADD-PATH 能力 |
| `sendAddPathMap` | object | 发送的 ADD-PATH 能力 |
| `addPathReceiveMap` | object | Router receive ADD-PATH 状态 |
| `addPathSendMap` | object | Router send ADD-PATH 状态 |
| `addPathMap` | object | 地址族维度 ADD-PATH 是否启用 |
| `peerUpTlvs` | TLV Item[] | Peer Up TLV |
| `peerDownTlvs` | TLV Item[] | Peer Down TLV |
| `lastRouteMonitoringTlvs` | TLV Item[] | 最近 Route Monitoring TLV |
| `peerDownReason` | integer/null | Peer Down reason |
| `peerDownFsmEventCode` | integer/null | FSM event code |
| `ribEpochMap` | object | RIB epoch |
| `routeSummary` | object | `{ active, stale, total }` |

示例：

```json
{
  "client": {
    "localIp": "127.0.0.1",
    "localPort": 11019,
    "remoteIp": "127.0.0.1",
    "remotePort": 50000
  }
}
```

### POST `/api/v1/bmp/instances`

查询指定 BMP 客户端下的 Loc-RIB instance。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |

返回 `data`：Instance 扩展对象数组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `addrFamilyType` | integer | 地址族枚举值 |
| `instanceType` | integer | BMP instance peer type |
| `instanceFlags` | integer/null | 生效后的 flags |
| `rawInstanceFlags` | integer/null | 原始 flags |
| `instanceRd` | string | RD |
| `instanceIp` | string/null | instance 地址 |
| `instanceAs` | integer/null | instance AS |
| `instanceRouterId` | string/null | Router ID |
| `instanceTimestamp` | integer/null | BMP peer header timestamp 秒 |
| `instanceTimestampMs` | integer/null | BMP peer header timestamp 微秒 |
| `localIp` | string/null | 本地地址 |
| `localPort` | integer/null | 本地端口 |
| `remotePort` | integer/null | 远端端口 |
| `instanceState` | integer/null | `0` Peer Up，`1` Peer Down |
| `recvAddressFamilies` | array | 收到的能力地址族 |
| `sendAddressFamilies` | array | 发送的能力地址族 |
| `enabledAddressFamilies` | array | 双方共同启用的地址族 |
| `enabledAddrFamilyTypes` | integer[] | 地址族枚举值 |
| `ribTypes` | integer[] | 支持的 RIB 类型枚举 |
| `recvAddPathMap` | object | 收到的 ADD-PATH 能力 |
| `sendAddPathMap` | object | 发送的 ADD-PATH 能力 |
| `addPathReceiveMap` | object | Router receive ADD-PATH 状态 |
| `addPathSendMap` | object | Router send ADD-PATH 状态 |
| `isAddPath` | boolean | 是否启用 ADD-PATH |
| `peerUpTlvs` | TLV Item[] | Peer Up TLV |
| `lastRouteMonitoringTlvs` | TLV Item[] | 最近 Route Monitoring TLV |
| `vrfTableNames` | string[] | VRF table name |
| `ribEpoch` | integer | RIB epoch |
| `routeSummary` | object | `{ active, stale, total }` |

### POST `/api/v1/bmp/routes`

分页查询 session RIB 路由。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |
| `session.sessionType` | integer | 是 | `0..255` | BMP peer type |
| `session.sessionRd` | string | 是 | 1..128 字符，不能包含控制字符 | RD |
| `session.sessionIp` | string | 是 | 1..128 字符，不能包含控制字符 | 被监控 BGP peer 地址 |
| `session.sessionAs` | integer | 是 | `0..4294967295` | 被监控 BGP peer AS |
| `af` | integer | 是 | 地址族枚举 `1..15` | 查询地址族 |
| `ribType` | integer | 是 | RIB 类型枚举 `1..5` | 查询 RIB |
| `page` | integer | 否 | `1..1000000` | 页码，默认 `1` |
| `pageSize` | integer | 否 | `1..设置页分页最大条数` | 每页条数，默认 `20` |
| `routeState` | string | 否 | `active`、`stale`、`all` | 路由状态过滤，默认 `active` |
| `prefixFilter` | string | 否 | 最大 128 字符，不能包含控制字符 | Prefix 或 Prefix/Mask 过滤，默认空 |

返回 `data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `list` | Route List Item[] | 当前页路由列表 |
| `total` | integer | 满足过滤条件的总数 |
| `summary` | object | 当前 RIB 的 `{ active, stale, total }` |

示例：

```json
{
  "client": {
    "localIp": "127.0.0.1",
    "localPort": 11019,
    "remoteIp": "127.0.0.1",
    "remotePort": 50000
  },
  "session": {
    "sessionType": 0,
    "sessionRd": "0:0",
    "sessionIp": "192.0.2.1",
    "sessionAs": 65001
  },
  "af": 1,
  "ribType": 2,
  "page": 1,
  "pageSize": 20,
  "routeState": "all",
  "prefixFilter": "10.0.0.0/24"
}
```

### POST `/api/v1/bmp/routes/detail`

查询 session RIB 路由详情。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |
| `session.sessionType` | integer | 是 | `0..255` | BMP peer type |
| `session.sessionRd` | string | 是 | 1..128 字符，不能包含控制字符 | RD |
| `session.sessionIp` | string | 是 | 1..128 字符，不能包含控制字符 | 被监控 BGP peer 地址 |
| `session.sessionAs` | integer | 是 | `0..4294967295` | 被监控 BGP peer AS |
| `af` | integer | 是 | 地址族枚举 `1..15` | 查询地址族 |
| `ribType` | integer | 是 | RIB 类型枚举 `1..5` | 查询 RIB |
| `routeKey` | string | 是 | 1..2048 字符，不能包含控制字符 | 路由列表返回的完整 `routeKey`；opaque 字符串，精确匹配 |

返回 `data`：Route Detail 对象；路由不存在时返回错误。路由 NLRI 解析结果在 `nlriDetail` 字段中。

### POST `/api/v1/bmp/instances/routes`

分页查询 Loc-RIB instance 路由。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |
| `instance.instanceType` | integer | 是 | `0..255` | BMP instance peer type |
| `instance.instanceRd` | string | 是 | 1..128 字符，不能包含控制字符 | RD |
| `instance.addrFamilyType` | integer | 是 | 地址族枚举 `1..15` | Loc-RIB instance 地址族 |
| `page` | integer | 否 | `1..1000000` | 页码，默认 `1` |
| `pageSize` | integer | 否 | `1..设置页分页最大条数` | 每页条数，默认 `20` |
| `routeState` | string | 否 | `active`、`stale`、`all` | 路由状态过滤，默认 `active` |
| `prefixFilter` | string | 否 | 最大 128 字符，不能包含控制字符 | Prefix 或 Prefix/Mask 过滤，默认空 |

返回 `data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `list` | Route List Item[] | 当前页路由列表 |
| `total` | integer | 满足过滤条件的总数 |
| `summary` | object | 当前 instance 的 `{ active, stale, total }` |

示例：

```json
{
  "client": {
    "localIp": "127.0.0.1",
    "localPort": 11019,
    "remoteIp": "127.0.0.1",
    "remotePort": 50000
  },
  "instance": {
    "instanceType": 3,
    "instanceRd": "0:0",
    "addrFamilyType": 1
  },
  "page": 1,
  "pageSize": 20,
  "routeState": "all",
  "prefixFilter": "10.0.0.0/24"
}
```

### POST `/api/v1/bmp/instances/routes/detail`

查询 Loc-RIB instance 路由详情。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |
| `instance.instanceType` | integer | 是 | `0..255` | BMP instance peer type |
| `instance.instanceRd` | string | 是 | 1..128 字符，不能包含控制字符 | RD |
| `instance.addrFamilyType` | integer | 是 | 地址族枚举 `1..15` | Loc-RIB instance 地址族 |
| `routeKey` | string | 是 | 1..2048 字符，不能包含控制字符 | 路由列表返回的完整 `routeKey`；opaque 字符串，精确匹配 |

返回 `data`：Route Detail 对象；路由不存在时返回错误。路由 NLRI 解析结果在 `nlriDetail` 字段中。

### POST `/api/v1/bmp/statistics/session`

查询 session 统计报表。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |

返回 `data`：统计报表数组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `client` | Client 扩展对象 | BMP 客户端信息 |
| `session` | Session 扩展对象 | BGP session 信息 |
| `ribType` | integer | RIB 阶段：`1` Pre Adj-RIB-In、`2` Post Adj-RIB-In、`4` Pre Adj-RIB-Out、`5` Post Adj-RIB-Out |
| `statistics` | Statistics Item[] | 统计项 |
| `tlvs` | TLV Item[] | BMPv4 Statistics Report TLV |
| `updatedAt` | string | 报表更新时间 ISO 字符串 |

### POST `/api/v1/bmp/statistics/instance`

查询 Loc-RIB instance 统计报表。

请求参数（下表列出接口实际读取的参数字段；返回对象里的其它字段不是必填，可原样带上但会被忽略）：

| 字段 | 类型 | 必填 | 范围/格式 | 说明 |
| --- | --- | --- | --- | --- |
| `client.localIp` | string | 是 | 1..128 字符，不能包含控制字符 | NetNexus 本地监听地址 |
| `client.localPort` | integer | 是 | `0..65535` | NetNexus 本地监听端口 |
| `client.remoteIp` | string | 是 | 1..128 字符，不能包含控制字符 | BMP 客户端地址 |
| `client.remotePort` | integer | 是 | `0..65535` | BMP 客户端端口 |

返回 `data`：统计报表数组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `client` | Client 扩展对象 | BMP 客户端信息 |
| `instance` | object | Loc-RIB instance 信息 |
| `statistics` | Statistics Item[] | 统计项 |
| `tlvs` | TLV Item[] | BMPv4 Statistics Report TLV |
| `updatedAt` | string | 报表更新时间 ISO 字符串 |

`instance` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `instanceType` | integer | BMP instance peer type |
| `instanceFlags` | integer | flags |
| `instanceRd` | string | RD |
| `instanceIp` | string | instance 地址 |
| `instanceAs` | integer | instance AS |
| `instanceRouterId` | string | Router ID |
| `instanceTimestamp` | integer | timestamp 秒 |
| `instanceTimestampMs` | integer | timestamp 微秒 |
| `vrfTableNames` | string[] | VRF table name |

## 推荐调用顺序

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 1 | `GET /api/v1/bmp/status` | 确认 BMP 已启动 |
| 2 | `GET /api/v1/bmp/clients` | 获取 client 标识 |
| 3 | `POST /api/v1/bmp/sessions` | 获取 session 标识 |
| 4 | `POST /api/v1/bmp/routes` | 分页查询 session 路由 |
| 5 | `POST /api/v1/bmp/routes/detail` | 使用 `routeKey` 查询详情 |

Loc-RIB 查询把第 3 到 5 步替换为：

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 3 | `POST /api/v1/bmp/instances` | 获取 instance 标识 |
| 4 | `POST /api/v1/bmp/instances/routes` | 分页查询 instance 路由 |
| 5 | `POST /api/v1/bmp/instances/routes/detail` | 使用 `routeKey` 查询详情 |

## Python 调用指导

以下示例只使用 Python 标准库，无需安装第三方依赖。

| 变量 | 说明 |
| --- | --- |
| `BASE_URL` | 外部 API 地址，例如 `http://127.0.0.1:18080` |
| `api_get(path)` | 发起 GET 请求 |
| `api_post(path, payload)` | 发起 POST JSON 请求 |

```python
import json
import urllib.error
import urllib.request

BASE_URL = "http://127.0.0.1:18080"


def request_api(method, path, payload=None):
    data = None
    headers = {
        "Accept": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return resp.status, body
    except urllib.error.HTTPError as exc:
        body = json.loads(exc.read().decode("utf-8"))
        return exc.code, body


def api_get(path):
    return request_api("GET", path)


def api_post(path, payload):
    return request_api("POST", path, payload)


status_code, status = api_get("/api/v1/bmp/status")
print(status_code, status)
if status_code != 200 or not status["data"]["running"]:
    raise RuntimeError("BMP is not running")

_, clients = api_get("/api/v1/bmp/clients")
client = clients["data"][0]

_, sessions = api_post("/api/v1/bmp/sessions", {"client": client})
session = sessions["data"][0]

route_query = {
    "client": client,
    "session": session,
    "af": session["enabledAddrFamilyTypes"][0],
    "ribType": session["ribTypes"][0],
    "page": 1,
    "pageSize": 20,
    "routeState": "all",
    "prefixFilter": "",
}
_, routes = api_post("/api/v1/bmp/routes", route_query)
print(routes["data"]["total"], routes["data"]["list"])

if routes["data"]["list"]:
    route_key = routes["data"]["list"][0]["routeKey"]
    _, detail = api_post(
        "/api/v1/bmp/routes/detail",
        {
            **route_query,
            "routeKey": route_key,
        },
    )
    print(detail["data"])
```

Python 错误处理建议：

| 场景 | 处理建议 |
| --- | --- |
| HTTP `409` + `BMP_NOT_RUNNING` | 提示用户先在 NetNexus BMP 页面启动 BMP |
| HTTP `400` + `INVALID_PARAMETER` | 打印 `msg`，修正请求参数范围 |

## Java 调用指导

以下示例使用 Java 11+ 标准库 `java.net.http.HttpClient`。JSON 字符串手工拼接只用于演示，生产代码建议使用 Jackson、Gson 等 JSON 库。

| 变量 | 说明 |
| --- | --- |
| `baseUrl` | 外部 API 地址，例如 `http://127.0.0.1:18080` |
| `get(path)` | 发起 GET 请求 |
| `post(path, json)` | 发起 POST JSON 请求 |

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class NetNexusApiExample {
    private static final String baseUrl = "http://127.0.0.1:18080";
    private static final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private static HttpResponse<String> get(String path) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .header("Accept", "application/json");
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> post(String path, String json) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json");
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    public static void main(String[] args) throws Exception {
        HttpResponse<String> status = get("/api/v1/bmp/status");
        System.out.println("status code: " + status.statusCode());
        System.out.println(status.body());

        HttpResponse<String> clients = get("/api/v1/bmp/clients");
        System.out.println("clients code: " + clients.statusCode());
        System.out.println(clients.body());

        String sessionRequest = """
                {
                  "client": {
                    "localIp": "127.0.0.1",
                    "localPort": 11019,
                    "remoteIp": "127.0.0.1",
                    "remotePort": 50000
                  }
                }
                """;
        HttpResponse<String> sessions = post("/api/v1/bmp/sessions", sessionRequest);
        System.out.println("sessions code: " + sessions.statusCode());
        System.out.println(sessions.body());

        String routesRequest = """
                {
                  "client": {
                    "localIp": "127.0.0.1",
                    "localPort": 11019,
                    "remoteIp": "127.0.0.1",
                    "remotePort": 50000
                  },
                  "session": {
                    "sessionType": 0,
                    "sessionRd": "0:0",
                    "sessionIp": "192.0.2.1",
                    "sessionAs": 65001
                  },
                  "af": 1,
                  "ribType": 2,
                  "page": 1,
                  "pageSize": 20,
                  "routeState": "all",
                  "prefixFilter": ""
                }
                """;
        HttpResponse<String> routes = post("/api/v1/bmp/routes", routesRequest);
        System.out.println("routes code: " + routes.statusCode());
        System.out.println(routes.body());
    }
}
```

Java 集成建议：

| 场景 | 建议 |
| --- | --- |
| 解析响应 | 使用 Jackson/Gson 把响应反序列化为 `ApiResponse<T>` |
| 超时控制 | 给 `HttpClient` 和单个 `HttpRequest` 都设置 timeout |
| 错误处理 | 先判断 HTTP 状态码，再判断响应体 `status` 和 `code` |
| client/session 获取 | 不建议手写固定值，优先从 `clients` 和 `sessions` 接口返回值中取 |

## JavaScript 调用指导

浏览器或 Node.js 18+ 可以直接使用 `fetch`。Node.js 16 及以下需要安装 `node-fetch` 或使用内置 `http` 模块。

| 变量 | 说明 |
| --- | --- |
| `baseUrl` | 外部 API 地址，例如 `http://127.0.0.1:18080` |
| `apiGet(path)` | 发起 GET 请求 |
| `apiPost(path, payload)` | 发起 POST JSON 请求 |

```js
const baseUrl = 'http://127.0.0.1:18080';

async function requestApi(method, path, payload) {
    const headers = {
        Accept: 'application/json'
    };
    const options = {
        method,
        headers
    };
    if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(payload);
    }

    const response = await fetch(`${baseUrl}${path}`, options);
    const body = await response.json();
    if (!response.ok || body.status !== 'success') {
        throw new Error(`${response.status} ${body.code || body.status}: ${body.msg || 'request failed'}`);
    }
    return body.data;
}

const apiGet = path => requestApi('GET', path);
const apiPost = (path, payload) => requestApi('POST', path, payload);

async function main() {
    const status = await apiGet('/api/v1/bmp/status');
    console.log('BMP status:', status);
    if (!status.running) {
        throw new Error('BMP is not running');
    }

    const clients = await apiGet('/api/v1/bmp/clients');
    const client = clients[0];

    const sessions = await apiPost('/api/v1/bmp/sessions', { client });
    const session = sessions[0];

    const routeQuery = {
        client,
        session,
        af: session.enabledAddrFamilyTypes[0],
        ribType: session.ribTypes[0],
        page: 1,
        pageSize: 20,
        routeState: 'all',
        prefixFilter: ''
    };
    const routes = await apiPost('/api/v1/bmp/routes', routeQuery);
    console.log('route total:', routes.total);
    console.log('route list:', routes.list);

    if (routes.list.length > 0) {
        const detail = await apiPost('/api/v1/bmp/routes/detail', {
            ...routeQuery,
            routeKey: routes.list[0].routeKey
        });
        console.log('route detail:', detail);
    }
}

main().catch(error => {
    console.error(error.message);
});
```

JavaScript 错误处理建议：

| 场景 | 处理建议 |
| --- | --- |
| `409 BMP_NOT_RUNNING` | 引导用户先启动 BMP |
| `400 INVALID_PARAMETER` | 直接展示响应体 `msg`，它会包含具体参数范围 |
| 空数组 | `clients`、`sessions`、`routes.list` 都可能为空，业务代码需要判空 |
