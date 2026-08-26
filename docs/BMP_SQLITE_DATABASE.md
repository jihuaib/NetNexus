# BMP SQLite 数据库说明

本文档说明 NetNexus BMP SQLite schema v13 的定位、固定路由分区、全局路由对象、整数代理键、候选驱动的对象回收、scope 计数，以及启动、写入、查询、清理和崩溃恢复行为。

如果目标是先理解页面怎么用、路由矩阵/路由追踪有什么区别，以及详情长什么样，请先看带截图的 [BMP 监控器说明](BMP_MONITOR.md)；本文继续解释这些页面怎样关联 SQLite 表并组装字段。

实现依据：

- Schema、事务、查询和清理：`electron/worker/bmp/bmpPersistenceStore.js`
- 固定分区清单和安全路由：`electron/worker/bmp/bmpRoutePartitionManifest.js`
- 稳定 source、scope、route ID：`electron/utils/bmpPersistentRouteKey.js`
- Mutation 构造：`electron/worker/bmp/bmpPersistenceMutation.js`
- 异步批量写入：`electron/worker/bmp/bmpPersistenceClient.js`
- BMP 生命周期：`electron/worker/bmp/bmpSession.js`
- Worker 启停和定时清理：`electron/worker/bmp/bmpWorker.js`

## 0. 先看这一节：页面上的一条路由是怎么查出来的

后面的章节是 schema 详细参考。如果只想弄清楚“表怎么关联”和“页面字段从哪里来”，先读完本节即可。

### 0.1 先记住一个模型

数据库里没有一张“什么都有的完整路由表”。页面上的一条完整路由是由下列数据在查询时组装出来的：

```text
页面路由
  = 这条路由属于哪个 RIB（scope）
  + 这条路由当前是否存在（current partition row）
  + 这是什么 NLRI（route identity）
  + 少量扩展展示字段（route payload）
  + BGP Path Attributes（route attributes）
  + 上报设备和连接信息（source + connection）
```

| 问题 | 从哪里回答 |
| --- | --- |
| “这是谁上报的？” | `bmp_sources` |
| “是哪次 TCP/BMP 连接上报的？” | `bmp_connections` |
| “属于哪个 Peer/Loc-RIB、AFI/SAFI、RIB 阶段？” | `bmp_rib_scopes` |
| “这个 scope 当前有没有这条路由？” | 某一张 `bmp_current_routes_*` 分区表 |
| “前缀、RD、Path ID、复杂 NLRI 是什么？” | `bmp_route_identities` |
| “Next Hop、AS Path、MED、Community 是什么？” | `bmp_route_attributes` |
| “Path Marking、Label、Route TLV 等扩展展示字段是什么？” | `bmp_route_payloads` |
| “当前有多少 active/stale 路由？” | `bmp_scope_route_counts` + `bmp_rib_scopes` |

### 0.2 一条 current route 的关联键

已知页面选中的 `scope_id`（外部稳定 hex ID）后，先在 `bmp_rib_scopes` 上把它换成整数 `scope_pk`，再按下面的方向关联：

```text
bmp_rib_scopes.scope_id ──> bmp_rib_scopes.scope_pk
  │
  ├─ partition_id ──> manifest ──> 选中一张 bmp_current_routes_* 表
  │                                      │
  │                                      ├─ route_pk      ──> bmp_route_identities.route_pk
  │                                      ├─ payload_id    ──> bmp_route_payloads.payload_id
  │                                      ├─ attr_pk       ──> bmp_route_attributes.attr_pk
  │                                      └─ connection_pk ──> bmp_connections.connection_pk
  │
  └─ source_pk ──> bmp_sources.source_pk
```

事实表（current 分区、`bmp_scope_route_counts`）只保存整数代理键；64 位 hex 的 `source_id`、`scope_id`、`attr_id` 和 UUID `connection_id` 只在各自维表里出现一次。这样每个索引条目从几十到上百字节缩到 8 字节，是 v10 写入吞吐和库体积改善的主要来源。

一条 current route 的业务唯一键是：

```text
(scope_pk, route_pk)
```

它的含义是“在这个明确的 RIB 空间里，当前存在这个 canonical NLRI”。同一个 `route_pk` 可以同时出现在 Pre-In、Post-In 和 Loc-RIB 等多个 scope 中。

### 0.3 最容易混淆的 ID

| ID | 唯一范围 | 用途 | 页面/API 是否应直接使用 |
| --- | --- | --- | --- |
| `source_id` / `source_pk` | 全库 | 稳定的 BMP 上报设备 ID（hex）及其数据库内部整数键；设备重连时复用 | `source_id` 可用于查询和运维；`source_pk` 只在库内 |
| `connection_id` / `connection_pk` | 全库 | 某一次 TCP/BMP 连接 ID（UUID）及其整数键；每次重连新建 | 通常只用于诊断 |
| `scope_id` / `scope_pk` | 全库 | 稳定的逻辑 RIB ID（hex）及其整数键；包含 source、Peer/Instance、AFI/SAFI、RIB stage | `scope_id` 是页面查询路由的首选条件 |
| `partition_id` | 全库 manifest | 把 scope 定向到一张物理 current 分区表 | 不由外部输入自行推导 |
| `route_pk` | 全库 | SQLite 内部短整数键，供 current/event 高效关联 identity | 不作为稳定外部 ID |
| `route_id` | 全库 | canonical route identity 的稳定 SHA-256 ID | 可用于跨 scope 查同一 NLRI |
| `legacy_route_key` / 返回字段 `routeKey` | 某种路由 key 规则 | 兼容旧页面和详情查询的 opaque key | 页面只应原样回传，不应自行拆解 |
| `path_pk` | **仅在某一张分区表内** | current 物理行主键和稳定分页辅助键 | 跨分区时必须与 `partition_id` 一起看 |
| `attr_id` / `attr_pk` | 全库 | canonical Path Attributes JSON 的内容哈希及其整数键 | 通常仅用于诊断 |
| `payload_id` | 全库 | 去重扩展 payload 的内部键 | 通常仅用于诊断 |

字段后缀也有统一含义：

| 后缀/命名 | 含义 |
| --- | --- |
| `*_id` | 稳定业务 ID、内容 ID，或被引用对象的 ID；具体类型要看字段表 |
| `*_pk` | SQLite 内部整数短键，不承诺可跨库复用；事实表和索引只引用这类键 |
| `*_ms` | Unix epoch 毫秒，不是格式化时间文本 |
| `*_epoch` | RIB 刷新代次，不是时间戳 |
| `*_json` | 序列化 JSON；查询后由应用解析并叠加到返回对象 |
| `*_state` | 当前状态或状态桶；需区分数据库存值与查询计算值 |

本文字段表中的 `PK`、`FK`、`UNIQUE`、`NOT NULL`、`CHECK` 表示 SQLite 真正强制的约束；只写“应用使用/约定”的枚举值则由代码保证。页面字段还可能是计算值，例如 `routeState` 不是表中某一列的直接别名。

### 0.4 具体例子：`10.0.0.0/24` 为什么只存一份 NLRI

以一条 IPv4 Unicast 路由为例。为便于阅读，下面省略了完整 hash。

`bmp_route_identities` 只保存一行：

```text
route_pk = 3
route_id = 87d911...
afi/safi = 1/1
prefix/prefix_length = 10.0.0.0/24
rd = 0:0
path_id = 0
nlri_json = {"pathId":0,"prefix":"10.0.0.0","length":24,"valid":true,"rd":"0:0"}
```

这条路由的扩展 payload 是空对象，所以与很多普通路由共享同一行：

```text
bmp_route_payloads.payload_id = 1
bmp_route_payloads.route_json = {}
```

路径属性也只保存一行：

```json
{
  "origin": "IGP",
  "asPath": "65000 65100",
  "med": 0,
  "localPref": 0,
  "nextHop": "172.28.115.3"
}
```

但这个 NLRI 当前同时出现在三个逻辑 RIB 中，所以有三行窄 current state：

| 物理分区 | scope 的 `rib_type` | scope（`scope_pk`） | `route_pk` | `payload_id` | `attr_pk` |
| --- | --- | --- | ---: | ---: | ---: |
| `bmp_current_routes_peer_ipv4_unicast` | `1` = Pre Adj-RIB-In | `scope-pre-in`（11） | 3 | 1 | 7 |
| `bmp_current_routes_peer_ipv4_unicast` | `2` = Post Adj-RIB-In | `scope-post-in`（12） | 3 | 1 | 7 |
| `bmp_current_routes_loc_rib_ipv4_unicast` | `loc-rib` | `scope-loc-rib`（13） | 3 | 1 | 7 |

因此，三个 RIB 各自保存“我当前包含 route 3”，但 NLRI JSON 和相同的 Path Attributes 不需要复制三份。

### 0.5 Session 路由页的完整调用链

例如用户在“BGP 会话”页选择：

```text
Client = router-a
Peer = 172.28.115.3 AS 65100
Address Family = IPv4 Unicast
RIB = Post Adj-RIB-In
State = Current（API 值 active）
Prefix = 10.0.0.0/24
Page = 1, Page Size = 25
```

真实调用链是：

```text
BgpSession.vue
  -> window.bmpApi.getBgpRoutes(...)
  -> Electron IPC: bmp:getBgpRoutes
  -> BmpApp.queryBgpRoutes(...)
  -> BmpWorker.getBgpRoutes(...)
  -> 用 Client + Session + AF + ribType 定位 scope_id
  -> BmpWorker.queryRouteScope(...)
  -> BmpPersistenceStore.queryRouteScope(...)
       ├─ queryRoutes({ scopeId, state, prefix, page })
       └─ queryScopeSummary({ scopeId })
  -> Worker 把完整路由裁剪成列表字段
  -> Vue 渲染表格和 active/stale/total 摘要
```

`queryRouteScope()` 会在同一个 SQLite 读事务中查路由列表和 scope 摘要，因此两部分看到同一个 WAL 快照。

Loc-RIB 页的链路几乎相同，只是用 Client + Instance 定位 `scope_kind = 'loc-rib'` 的 `scope_id`，然后定向 `bmp_current_routes_loc_rib_*` 分区。

这里最关键的一点是：Client、Session/Instance、AFI/SAFI 和 `ribType` 主要用于**定位并校验 `persistentScopeId`**。一旦得到 `scope_id`，实际页面 SQL 就不再分别拿这些业务字段做多表模糊匹配，因为一个 scope 已经唯一固定了 source、owner、地址族、RIB stage 和物理分区。正常的 Session/Loc-RIB 页面查询因此只访问 1 张 current 分区表。

### 0.6 数据库实际如何选表和 JOIN

第一步不是扫描 36 张表，而是用 `scope_id` 找到固定分区和整数键：

```sql
SELECT scope_pk, partition_id
  FROM bmp_rib_scopes
 WHERE scope_id = :scope_id
 LIMIT 1;
```

例如 `partition_id = 101` 由固定 manifest 解析为 `bmp_current_routes_peer_ipv4_unicast`。表名来自 manifest，不会拼接页面输入。

下面的 SQL 是生产查询的等价简化版，展示了关键 JOIN 和字段来源：

```sql
WITH current_expanded AS (
    SELECT current.partition_id,
           current.path_pk,
           current.scope_pk,
           current.route_pk,
           current.payload_id,
           current.attr_pk,
           current.connection_pk,
           current.rib_epoch,
           current.explicit_state,
           current.first_seen_ms,
           current.last_seen_ms,
           current.source_timestamp_ms,
           identity.route_id,
           identity.route_key_version,
           identity.legacy_route_key,
           identity.afi,
           identity.safi,
           identity.path_id,
           identity.rd,
           identity.prefix,
           identity.prefix_length,
           identity.nlri_json,
           payload.route_json
      FROM bmp_current_routes_peer_ipv4_unicast AS current
      JOIN bmp_route_identities AS identity
        ON identity.route_pk = current.route_pk
      JOIN bmp_route_payloads AS payload
        ON payload.payload_id = current.payload_id
), assembled AS (
    SELECT route.*,
           scope.scope_id,
           source.source_id,
           connection.connection_id,
           attributes.attr_id,
           scope.scope_kind,
           scope.owner_key,
           scope.peer_type,
           scope.peer_rd,
           scope.peer_ip,
           scope.peer_as,
           scope.vrf_name,
           scope.rib_type,
           scope.current_epoch,
           scope.eor_epoch,
           scope.scope_state,
           scope.stale_reason AS scope_stale_reason,
           attributes.attr_json,
           source.remote_ip AS source_remote_ip,
           source.sys_name,
           source.sys_desc,
           connection.local_ip AS connection_local_ip,
           connection.local_port AS connection_local_port,
           connection.remote_ip AS connection_remote_ip,
           connection.remote_port AS connection_remote_port,
           CASE
             WHEN route.explicit_state = 'stale'
               OR scope.scope_state IN ('stale', 'down')
               OR route.connection_pk IS NOT scope.last_connection_pk
               OR route.rib_epoch < scope.current_epoch
             THEN 'stale'
             ELSE 'active'
           END AS effective_state
      FROM current_expanded AS route
      JOIN bmp_rib_scopes AS scope
        ON scope.scope_pk = route.scope_pk
      JOIN bmp_sources AS source
        ON source.source_pk = scope.source_pk
      JOIN bmp_connections AS connection
        ON connection.connection_pk = route.connection_pk
      LEFT JOIN bmp_route_attributes AS attributes
        ON attributes.attr_pk = route.attr_pk
     WHERE scope.scope_id = :scope_id
       AND route.route_pk IN (
           SELECT route_pk
             FROM bmp_route_identities
            WHERE prefix = :prefix
              AND prefix_length = :prefix_length
       )
)
SELECT *
  FROM assembled
 WHERE effective_state = :route_state
 ORDER BY first_seen_ms, path_pk
 LIMIT :page_size_plus_one
OFFSET :offset;
```

查询使用 `page_size + 1` 条在内部判断是否还有下一页；真正返回页面前会裁掉额外的一条。Session/Loc-RIB 使用 `firstSeen` 的页码分页，页面最终主要根据过滤后的 `total` 计算总页数。

IPv4/IPv6 Unicast 输入 `10.0.0.0/24` 时，上述条件是标准化后的**精确前缀和掩码匹配**，不是最长前缀匹配（LPM）。输入纯 IP 时按精确 IP 匹配；其他文本才按页面支持的文本规则过滤。

`bmp_route_attributes` 使用 `LEFT JOIN`，因为某些 current route 观测没有可用 `attr_pk`；identity 和 payload 是 current route 的必需对象，因此使用普通 `JOIN`。Withdraw 自身只写历史 event，并在有效 connection/epoch 下删除 current row，不会作为 current row 留在该查询里。

### 0.7 SQL 行如何组装成页面路由

SQL 查出一个展开行后，`buildStoredRouteProjection()` 按以下顺序组装路由：

```text
1. identity 列 + nlri_json
   -> afi, safi, ip, mask, rd, pathId, nlriDetail, routeKey，以及 routeType/rawNlri 默认值

2. payload.route_json 覆盖少量扩展字段
   -> labels, rdRaw, routeType 覆盖值、Path Marking、routeTlvs、parseStatus ...

3. attributes.attr_json 覆盖 BGP Path Attributes
   -> origin, asPath, nextHop, localPref, med, communities, otc, prefixSid ...

4. current row + scope + connection + source 补充持久化状态
   -> routeState, staleReason, ribEpoch, scopeState, ribType, peer, source,
      firstSeenAt, lastSeenAt, sourceTimestampMs ...
```

主要页面字段来源：

| 返回/页面字段 | 数据来源 | 备注 |
| --- | --- | --- |
| `routeKey` | `bmp_route_identities.legacy_route_key` | 详情查询原样回传 |
| `persistentRouteId` | `bmp_route_identities.route_id` | 稳定 canonical route ID；详情对象保留，普通列表会裁掉 |
| `persistentScopeId` | `bmp_rib_scopes.scope_id`（经 current `scope_pk` 关联） | 页面查询的逻辑 RIB 主键；详情对象保留 |
| `persistentSourceId` | `bmp_sources.source_id`（经 scope 的 `source_pk` 关联） | 稳定上报源 ID |
| `persistentConnectionId` | `bmp_connections.connection_id`（经 current `connection_pk` 关联） | 该 current 版本来自的连接 ID |
| `afi` / `safi` | `bmp_route_identities` | 同时用于分区校验 |
| `ip` / `mask` | `prefix` / `prefix_length` | 复杂 NLRI 可能为 `NULL` |
| `rd` / `pathId` | `bmp_route_identities` | 属于 canonical route identity |
| `rdRaw` | `nlri_json`，可由 `route_json` 覆盖 | 保留无法规范化成普通 RD 文本的原始值 |
| `nlriDetail` | `bmp_route_identities.nlri_json` | EVPN、MVPN、BGP-LS 等详细结构 |
| `origin` / `asPath` / `nextHop` / `localPref` / `med` / `communities` | `bmp_route_attributes.attr_json` | 同一组属性跨路由共享 |
| `routeType` / `rawNlri` | `bmp_route_identities.nlri_json` | 先作为 identity/NLRI 默认展示值；payload 如有同名值可覆盖 |
| `labels` / Path Marking / `routeTlvs` / parser 状态 | `bmp_route_payloads.route_json` | 只保存不能从 identity/attributes/state 重建的扩展字段 |
| `ribType` / Peer / VRF | `bmp_rib_scopes` | 同一物理 Peer 的 Pre/Post 阶段是不同 scope |
| `routeState` | current row + scope 动态计算 | 不只看 `explicit_state` |
| `ribEpoch` | current 分区行 `rib_epoch` | 该路由行属于哪一代刷新 |
| `currentEpoch` / `eorEpoch` / `scopeState` | `bmp_rib_scopes` | 用于计算 active/stale 和刷新状态 |
| `firstSeenAt` / `lastSeenAt` | current 分区行 | 该 scope 内路由的首次/最近观测时间 |
| `sourceTimestampMs` | current 分区行 | BMP Peer Header 中的 source 时间，可空 |
| `source` | `bmp_sources` + `bmp_connections` | 连接地址优先，source 地址作回退 |
| active/stale/total 摘要 | `bmp_scope_route_counts` + `bmp_rib_scopes` | 无前缀条件时不扫描 current 分区 |

组装后的详情对象类似：

```json
{
  "routeKey": "0|0:0|10.0.0.0|24",
  "persistentRouteId": "87d911...",
  "persistentScopeId": "scope-post-in",
  "persistentSourceId": "source-router-a",
  "persistentConnectionId": "connection-2026-07-17",
  "afi": 1,
  "safi": 1,
  "ip": "10.0.0.0",
  "mask": 24,
  "rd": "0:0",
  "pathId": 0,
  "origin": "IGP",
  "asPath": "65000 65100",
  "nextHop": "172.28.115.3",
  "localPref": 0,
  "med": 0,
  "routeState": "active",
  "scopeKind": "peer",
  "ribType": "2",
  "peer": {
    "ip": "172.28.115.3",
    "as": "65100",
    "vrf": null
  },
  "source": {
    "localIp": "192.0.2.10",
    "remoteIp": "192.0.2.20",
    "sysName": "router-a"
  }
}
```

Session/Loc-RIB **列表**不会把这个对象的所有字段发给表格；Worker 会再裁剪为 Prefix、Mask、Next Hop、AS Path、RD、Path ID、Label、Origin、MED、Path Status、Route State 等列表字段。

页面响应里有两个容易混淆的统计口径：

| 返回字段 | 口径 | 是否受页面 `state` / `prefix` 过滤影响 |
| --- | --- | --- |
| `total` | 当前列表条件命中的路由数，用于分页 | **受影响** |
| `summary.active/stale/total` | 整个 scope 的 active/stale/total 摘要 | **不受影响** |

例如该 scope 一共有 1000 条路由，前缀过滤只命中 1 条，则响应可以同时是 `total = 1`、`summary.total = 1000`。没有 prefix/text 等路由级条件时，列表 `total` 也可直接由 counter 求出；存在这些条件时才对选中的分区执行带 JOIN 的 `COUNT(*)`。

### 0.8 列表、详情、Route Lens 的查询差异

| 功能 | 主要查询条件 | 访问的 current 分区 | 最终返回 |
| --- | --- | --- | --- |
| Session 路由列表 | `scope_id + state + prefix + page` | 已知 scope，只访问 1 张 | 裁剪后的列表字段 + scope 摘要 |
| Loc-RIB 路由列表 | `scope_id + state + prefix + page` | 已知 scope，只访问 1 张 loc-rib 分区 | 裁剪后的列表字段 + scope 摘要 |
| 路由详情 | `scope_id + legacy_route_key` | 只访问 scope 所在的 1 张 | 完整组装对象；没有单独的 detail 表 |
| Route Lens | IP/CIDR/NLRI 查询 + state | 按 AFI/SAFI 剪枝；文本 NLRI 查询可能跨多分区 | 将同一查询的路由按五个 RIB stage 分组 |
| Route Assurance | 全量 current 快照 + 页面筛选 | 可跨多分区分页扫描 | 五阶段漏斗和异常候选 |

路由详情与列表复用同一套组装逻辑。详情查询只是把 `routeState` 设为 `all`，加上 `legacy_route_key` 精确条件并限制 `pageSize = 1`。

数据库只保存 current 投影：成功 withdraw/purge 且未重新宣告的路由会从分区表删除，之后没有任何页面或 API 能再查到它。v11 起没有路由事件表，也没有“路由轨迹/事件轨迹”功能。

复杂 NLRI 的 `bmp_route_identities.prefix` 保存 parser 生成的可读标识，Route Lens 用它做从头匹配，例如：

- EVPN：`evpn:mac-ip:65000:41:tag=141:mac=aa:bb:cc:dd:ee:29:ip=192.0.2.51`
- BGP-LS：`bgp-ls:Link:10.250.0.1->10.250.0.2`
- FlowSpec：`dst=198.18.253.0/24; proto = 6; dst-port = 443`

复杂 NLRI 的 `prefix_length` 是 parser 长度元数据，不是 CIDR Mask，页面不会把它拼成 `/Mask`。

## 1. 数据库定位

SQLite 是 BMP RIB 的权威数据源，不是可选的历史副本。

- 完整 current RIB、路由事件和 Statistics Report 保存在 SQLite。
- 内存只保留在线连接、协议解析上下文、scope 元数据、少量摘要和页面增量状态。
- BGP Session、Loc-RIB Instance 和路由页面可在 BMP Worker 重启后从 SQLite 恢复。
- 数据库无法打开或 Writer 失败时，BMP 会 fail-closed，暂停继续接收数据，避免内存状态领先于数据库。

数据库基本信息：

| 项目 | schema v10 的值 |
| --- | --- |
| 数据库文件 | 通常为 Electron `userData/bmp/bmp.sqlite3` |
| Schema version | `13`，保存在 `PRAGMA user_version` |
| 稳定键 schema version | `2`（固定顺序的规范化字符串哈希，见 7.1） |
| 稳定键算法 | SHA-256 |
| Journal 模式 | WAL |
| 外键 | DDL 中声明，但连接上 `foreign_keys = OFF`（引用完整性由 Writer 保证；`PRAGMA foreign_key_check` 仍可校验） |
| 同步级别 | `synchronous = OFF`（进程崩溃不丢数据；操作系统崩溃/断电可能丢最近几秒写入，库损坏时启动自动重建） |
| Busy timeout | 5000 ms |
| 临时存储 | MEMORY |
| Writer 页缓存 | 64 MiB（`cache_size = -65536`） |
| Reader mmap | 256 MiB（`mmap_size`，只读连接） |
| WAL 自动 checkpoint | 2000 页 |

WAL 模式运行时，数据库目录还可能存在：

- `bmp.sqlite3-wal`：尚未 checkpoint 回主文件的已提交 WAL 页面。
- `bmp.sqlite3-shm`：WAL 共享内存索引。

## 2. Schema v13 的核心变化

v10~v13 保留 v9 的固定分区和全局对象去重，重点是为“大量邻居同时全表上报”这类写入场景瘦身：

1. current route 固定拆成 `2 × 18 = 36` 张物理分区表（同 v9）。
2. Route identity/NLRI、扩展展示 payload 和 path attributes 分开全局去重，分区表只保留当前路径状态和外键（同 v9）。
3. `bmp_sources`、`bmp_connections`、`bmp_rib_scopes`、`bmp_route_attributes` 改为 rowid 表并暴露整数代理键 `source_pk`、`connection_pk`、`scope_pk`、`attr_pk`；current 分区和 `bmp_scope_route_counts` 只引用这些整数键，hex/UUID ID 仅在维表出现一次。
4. 取消 `current_ref_count` / `event_ref_count` 和维护它们的 trigger。identity、payload、attributes 的回收改为“候选驱动”：删除或替换 current row 时把旧引用键记入临时候选表，sweep/清理/删除 Source 时用反连接删除已无任何引用的候选。写入热路径不再为 GC 付出任何额外 UPDATE。
5. **v11 删除了路由事件表 `bmp_route_events` 和整个路由历史/事件轨迹功能。** 数据库只保存 current RIB 投影和 Statistics Report；重放去重改由 `bmp_connections.last_sequence` 承担，current 行的版本保护改用 mutation 序号 `last_sequence`。
6. current 分区从 6 个二级索引精简到 5 个；`bmp_route_identities` 去掉冗余的 `route_key_json` 列和一个前缀索引。
7. Scope route counters 仍由 trigger 在事务内维护（同 v9）。
8. **v13** 稳定键算法升为 v2：`route_id` / `scope_id` 哈希固定顺序的规范化字符串而不是排序 JSON（见 7.1）；同一路由的判定语义不变，键值不同。同时 bmpWorker 侧按邻居缓存 scope 描述符、按属性对象缓存 attr JSON/哈希、按文本缓存前缀归一化，并在批次传输时只发送一份 source/scope/connection 描述符。
9. **v12** 去掉 `bmp_route_identities.route_identity_json`（碰撞检测只依赖 SHA-256），普通 IP 前缀的 `nlri_json` 不再落库（`nlri_json = NULL`，`nlri_flags` 记录可选键，读取时由拆列重建完全相同的对象）。
10. **写入攒批**：一个批次内所有 identity / payload / attribute 先各用一条多行 `INSERT OR IGNORE`（每 250 行一条）写入，再用一条 `SELECT … IN (...)` 取回主键；不再对每条路由做带 `RETURNING` 的 upsert。分析未开启时 announce 也不再读取旧行的完整投影，只探测被替换的 payload/attr 主键用于回收。
11. 版本不匹配时不迁移：Writer 打开数据库发现 `user_version` 不等于 13（更旧、更新、或未版本化但非空），会删除全部已有对象并重建空库。

以 20 个邻居 × 2 万条路由的本机基准计，v10 相比 v9 写入吞吐约 2 倍（6.0k → 11.6k routes/s），数据库体积约 1/3（1010 MB → 351 MB）；v11 去掉事件表后见第 10 节的数据。

## 3. 数据库对象总览

### 3.1 全局业务表

| 表 | 主要职责 |
| --- | --- |
| `bmp_sources` | BMP 上报设备的稳定身份 |
| `bmp_connections` | 每次 TCP/BMP 连接历史 |
| `bmp_rib_scopes` | Peer/Loc-RIB 的 AFI、SAFI、RIB 生命周期和分区归属 |
| `bmp_scope_route_counts` | 按 scope、connection、epoch、显式状态维护 current route 数量 |
| `bmp_route_attributes` | 全局去重的 BGP Path Attributes |
| `bmp_route_identities` | 全局去重的 canonical NLRI identity |
| `bmp_route_payloads` | 全局去重的 route 扩展展示字段 JSON；普通路由可以共享 `{}` |
| `bmp_ingest_batches` | 批量写入幂等记录 |
| `bmp_statistics_samples` | Statistics Report 历史样本 |
| `bmp_statistics_latest` | 每个逻辑 Statistics Report 的最新样本投影 |

### 3.2 Current-route 分区

`bmpRoutePartitionManifest.js` 固定声明 36 张 current-route 表：

```text
bmp_current_routes_{peer|loc_rib}_{family_token}
```

每个分区使用相同字段、索引和 trigger，仅 `partition_id`、`scope_kind` 和允许的 AFI/SAFI 不同。

### 3.3 统一视图

`bmp_current_routes_all` 是 36 张分区的只读 `UNION ALL` 视图。视图会关联：

- 当前路径分区行；
- `bmp_route_identities`；
- `bmp_route_payloads`。

视图固定输出 26 列：

| 来源 | 输出字段 |
| --- | --- |
| Current 分区行（13 列） | `partition_id`、`path_pk`、`scope_pk`、`route_pk`、`payload_id`、`attr_pk`、`connection_pk`、`rib_epoch`、`explicit_state`、`first_seen_ms`、`last_seen_ms`、`source_timestamp_ms`、`last_sequence` |
| Route identity（12 列） | `route_id`、`route_key_version`、`legacy_route_key`、`afi`、`safi`、`path_id`、`rd`、`prefix`、`prefix_length`、`nlri_kind`、`nlri_json`、`nlri_flags` |
| Route payload（1 列） | `route_json` |

另有一个更轻的 `bmp_current_route_refs` 视图，只 `UNION ALL` 36 张分区的 `(scope_pk, route_pk, payload_id, attr_pk)`，不做任何 JOIN；对象 GC 的反连接和诊断用它探测“某个对象是否还被任何 current row 引用”。

它**不包含** `attr_json`、scope、source 或 connection 展示字段，这些仍需分别关联 `bmp_route_attributes`、`bmp_rib_scopes`、`bmp_sources` 和 `bmp_connections`。

该 view 主要用于真正的跨分区查询和运维检查。生产页面已知 `scope_id` 时，不会先扫这个 36 分区 view；查询代码会生成相同的 identity/payload 展开 SQL，但只针对 manifest 选中的 1 张物理表。

SQLite 还会自动创建 `sqlite_sequence`，用于记录 `bmp_statistics_samples.sample_id` 的 AUTOINCREMENT 进度。不要手工修改该表。

## 4. 固定分区清单

### 4.1 Scope kind

物理分区只接受两个 `scope_kind`：

| scope_kind | Owner | BMP peer type | 表名 token |
| --- | --- | --- | --- |
| `peer` | `BmpBgpSession` | Global、L3VPN、Local，即 0、1、2 | `peer` |
| `loc-rib` | `BmpBgpInstance` | Local RIB，即 3 | `loc_rib` |

`bmp_rib_scopes.scope_kind` 有 `CHECK(scope_kind IN ('peer', 'loc-rib'))`。`session`、`instance`、`loc_rib` 等文本不是数据库合法值。

### 4.2 地址族和 partition ID

下表中的 `familyId`、family key 和 token 都是代码 manifest 元数据，不是 SQLite 表字段；真正持久化到 scope、current row 和 event 的只有 `partition_id`。表名也只由 manifest 在应用内解析。

| `familyId` | family key | token | AFI | SAFI | peer partition | loc-rib partition |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 1 | `ipv4-unicast` | `ipv4_unicast` | 1 | 1 | 101 | 201 |
| 2 | `ipv6-unicast` | `ipv6_unicast` | 2 | 1 | 102 | 202 |
| 3 | `ipv4-multicast` | `ipv4_multicast` | 1 | 2 | 103 | 203 |
| 4 | `ipv6-multicast` | `ipv6_multicast` | 2 | 2 | 104 | 204 |
| 5 | `ipv4-labeled-unicast` | `ipv4_labeled_unicast` | 1 | 4 | 105 | 205 |
| 6 | `ipv6-labeled-unicast` | `ipv6_labeled_unicast` | 2 | 4 | 106 | 206 |
| 7 | `ipv4-mvpn` | `ipv4_mvpn` | 1 | 5 | 107 | 207 |
| 8 | `ipv6-mvpn` | `ipv6_mvpn` | 2 | 5 | 108 | 208 |
| 9 | `l2vpn-evpn` | `l2vpn_evpn` | 25 | 70 | 109 | 209 |
| 10 | `vpnv4` | `vpnv4` | 1 | 128 | 110 | 210 |
| 11 | `vpnv6` | `vpnv6` | 2 | 128 | 111 | 211 |
| 12 | `ipv4-flowspec` | `ipv4_flowspec` | 1 | 133 | 112 | 212 |
| 13 | `ipv6-flowspec` | `ipv6_flowspec` | 2 | 133 | 113 | 213 |
| 14 | `ipv4-qp` | `ipv4_qp` | 1 | 241 | 114 | 214 |
| 15 | `ipv6-qp` | `ipv6_qp` | 2 | 241 | 115 | 215 |
| 16 | `bgp-ls` | `bgp_ls` | 16388 | 71 | 116 | 216 |
| 17 | `bgp-ls-vpn` | `bgp_ls_vpn` | 16388 | 72 | 117 | 217 |
| 18 | `other` | `other` | 任意其他合法值 | 任意其他合法值 | 118 | 218 |

例如：

- Peer IPv4 Unicast：`bmp_current_routes_peer_ipv4_unicast`
- Loc-RIB EVPN：`bmp_current_routes_loc_rib_l2vpn_evpn`
- Peer 未知地址族：`bmp_current_routes_peer_other`

`familyId` 是 manifest 中显式固定且全局唯一的稳定编号，不依赖数组顺序。当前 `partition_id` 按 `100 + familyId`（peer）或 `200 + familyId`（loc-rib）生成，并同时持久化在 scope、current route 和带 scope 的 event 中。已发布的 `familyId` 不得重编号或复用；不要从数组位置或外部输入自行推导分区，应始终使用 manifest。

### 4.3 `other` 分区

AFI 必须是 0 到 65535 的整数，SAFI 必须是 0 到 255 的整数。

- 格式合法但不属于前述 17 组的组合进入对应 owner 的 `other` 分区。
- 缺失、负数、小数或越界值直接拒绝，不会进入 `other`。
- `other` 行仍通过 `bmp_route_identities` 保存实际 AFI 和 SAFI。

### 4.4 安全路由

分区表名不能由 API 参数直接拼接。写入过程必须：

1. 验证 `scope_kind`、AFI 和 SAFI。
2. 通过固定 manifest 解析 descriptor。
3. 将 descriptor 的 `partition_id` 保存到 `bmp_rib_scopes`。
4. 只使用 descriptor 中预先校验的表名准备 SQL。
5. 校验 route 的 AFI/SAFI 与 scope 完全一致。

数据库内还有连续的校验链：

- Scope insert/update trigger 验证 `(partition_id, scope_kind, afi, safi)` 必须与 manifest 中的某个 descriptor 匹配：known-family 必须精确匹配，`other` 必须排除 17 个已知组合；AFI/SAFI 的类型和取值范围由进入数据库前的 manifest resolver 校验。
- 每张分区表的 `partition_id` 有固定值 `CHECK`，并通过 `(scope_pk, partition_id)` 复合外键指向 `bmp_rib_scopes`。
- 分区 insert trigger 同时关联 scope 和 route identity，验证 scope 的 partition、kind、AFI/SAFI、identity 的 AFI/SAFI 与目标分区一致。
- 分区行一旦建立，`scope_pk`、`partition_id` 和 `route_pk` 不可更新，避免绕过上述校验把路径移动到另一个 scope、分区或 identity。

## 5. 表关联图

```text
bmp_sources
  ├── 1:N ── bmp_connections
  ├── 1:N ── bmp_rib_scopes
  ├── 1:N ── bmp_statistics_samples
  └── 1:N ── bmp_statistics_latest

bmp_connections
  ├── 1:N ── bmp_rib_scopes.last_connection_pk
  ├── 1:N ── 36 张 current-route 分区.connection_pk
  ├── 1:N ── bmp_scope_route_counts.connection_pk
  └── 1:N ── bmp_statistics_samples.connection_id（文本 ID）

bmp_rib_scopes
  ├── 1:N ── 所属的一张 current-route 分区
  ├── 1:N ── bmp_scope_route_counts
  └── 1:N ── bmp_statistics_samples.scope_id（文本 ID），可为空

bmp_route_identities
  └── 1:N ── current-route 分区.route_pk

bmp_route_payloads
  └── 1:N ── current-route 分区.payload_id

bmp_route_attributes
  └── 1:N ── current-route 分区.attr_pk，可为空

bmp_statistics_samples
  └── 应用通常 1:0..1 ── bmp_statistics_latest.sample_id
```

实际 JOIN/FK 列如下。看到同名的 `source_id` 或 `route_pk` 时，不需要猜关联方式：

| 子表字段 | 父表字段 | 数据库 FK | 删除行为/用途 |
| --- | --- | --- | --- |
| `bmp_connections.source_pk` | `bmp_sources.source_pk` | 是 | 默认 `NO ACTION` |
| `bmp_rib_scopes.source_pk` | `bmp_sources.source_pk` | 是 | 默认 `NO ACTION` |
| `bmp_rib_scopes.last_connection_pk` | `bmp_connections.connection_pk` | 是，可空 | 当前接管 scope 的连接 |
| `current.(scope_pk, partition_id)` | `bmp_rib_scopes.(scope_pk, partition_id)` | 是，复合 FK | `ON DELETE CASCADE` |
| `current.route_pk` | `bmp_route_identities.route_pk` | 是 | NLRI identity |
| `current.payload_id` | `bmp_route_payloads.payload_id` | 是 | 扩展展示 payload |
| `current.attr_pk` | `bmp_route_attributes.attr_pk` | 是，可空 | Path Attributes |
| `current.connection_pk` | `bmp_connections.connection_pk` | 是 | 当前版本来自哪次连接 |
| `bmp_scope_route_counts.scope_pk` | `bmp_rib_scopes.scope_pk` | 是 | `ON DELETE CASCADE` |
| `bmp_scope_route_counts.connection_pk` | `bmp_connections.connection_pk` | 是 | 计数桶所属连接 |
| `bmp_statistics_samples.source_id` | `bmp_sources.source_id` | 是 | 统计样本所属 source |
| `bmp_statistics_samples.connection_id` | `bmp_connections.connection_id` | 是 | 统计样本所属连接 |
| `bmp_statistics_samples.scope_id` | `bmp_rib_scopes.scope_id` | 是，可空 | 可选 RIB scope |
| `bmp_statistics_latest.source_id` | `bmp_sources.source_id` | 是 | 最新投影所属 source |
| `bmp_statistics_latest.sample_id` | `bmp_statistics_samples.sample_id` | 是 | 最新样本 |

DDL 里的两条 `ON DELETE CASCADE` 和其他 FK 都只是声明：Writer 连接关闭了外键检查，级联不会发生，删除 source 时 `purgeSource()` 会显式删除 current 行、计数行、scope、connection。运维可用 `PRAGMA foreign_key_check` 检查引用完整性。

`partition_id` 与 `scope_pk` 一起重复保存在 current 行中，是为了让数据库能用复合 FK 和 trigger 校验“这行确实属于该 scope 对应的固定分区”；它不是另一套 scope ID。

`current.last_sequence` 记录写入该版本的 mutation 在其连接内的序号，用于 upsert 版本保护（同一连接内旧序号不能覆盖新状态）；页面排序不使用它。`bmp_ingest_batches` 只承担批次幂等，按时间独立清理。

另外，`bmp_statistics_latest.sample_id` 只有普通 FK、没有 `UNIQUE`。正常写入语义是一条 sample 最多成为一个逻辑报告的 latest，但 DDL 本身允许多行 latest 引用同一 sample，因此图中的 `1:0..1` 是应用语义，不是 SQLite 强制基数。

## 6. Source、connection 和 scope

### 6.1 `bmp_sources`

一行代表一个稳定 BMP 上报源。完整字段：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `source_pk` | INTEGER PK | 数据库内部整数键；connections、scopes、events 引用它 |
| `source_id` | TEXT NOT NULL UNIQUE | 规范化 source identity 的 SHA-256 十六进制值；对外稳定 ID |
| `source_key_json` | TEXT NOT NULL | 键版本、算法和 keyHex |
| `source_identity_json` | TEXT NOT NULL | 生成 source ID 的规范化身份 |
| `remote_ip` | TEXT NULL | 最近已知的 BMP 发起端地址 |
| `sys_name` | TEXT NULL | BMP Initiation 中的系统名 |
| `sys_desc` | TEXT NULL | BMP Initiation 中的系统描述 |
| `first_seen_ms` | INTEGER NOT NULL | Source 首次观察时间 |
| `last_seen_ms` | INTEGER NOT NULL | Source 最近观察时间 |
| `metadata_json` | TEXT NULL | BMP version、v4 TLV draft 等扩展元数据 |

设备重连时复用稳定 `source_id`，但会创建新的 connection。

### 6.2 `bmp_connections`

一行代表一次 TCP/BMP 连接。设备每次重连都创建新的 `connection_id`，但继续引用同一个 `source_id`。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `connection_pk` | INTEGER PK | 数据库内部整数键；scopes、current 分区、counters、events 引用它 |
| `connection_id` | TEXT NOT NULL UNIQUE | 单次 TCP/BMP 连接的全库 ID（UUID） |
| `source_pk` | INTEGER NOT NULL，FK | 所属稳定 source，关联 `bmp_sources.source_pk` |
| `connection_generation` | INTEGER NOT NULL | 应用生成的连接代次，用于新连接接管旧 scope |
| `local_ip` | TEXT NULL | Collector 本地地址 |
| `local_port` | INTEGER NULL | Collector 本地端口 |
| `remote_ip` | TEXT NULL | BMP 设备远端地址 |
| `remote_port` | INTEGER NULL | BMP 设备远端端口 |
| `opened_at_ms` | INTEGER NOT NULL | 连接打开时间 |
| `closed_at_ms` | INTEGER NULL | 连接关闭时间；在线时为空 |
| `close_reason` | TEXT NULL | 关闭原因 |
| `connection_state` | TEXT NOT NULL | 应用使用 `open` / `closed`；DDL 没有枚举 CHECK |
| `last_sequence` | INTEGER NOT NULL，DEFAULT `0` | 该连接已提交的最大 mutation 序号；重放去重的依据 |

`connection_generation` 的单调性由 Writer 保证，数据库没有为它声明 UNIQUE。

Mutation 在一个连接内按 `source_sequence` 严格递增到达。Writer 在触碰 scope/route 之前先比较序号：小于等于 `last_sequence` 的 mutation 视为重放，是完全的 no-op；批次提交时把批内最大序号写回。整批重试由 `bmp_ingest_batches` 的 `batch_id` 幂等保证，事务回滚时序号不会推进。

`idx_bmp_connections_source_time(source_pk, opened_at_ms DESC)` 用于查某 source 的连接历史。

### 6.3 `bmp_rib_scopes`

一个 scope 表示一个明确路由空间：

```text
source
  + peer 或 loc-rib 身份
  + AFI
  + SAFI
  + RIB stage
```

完整字段：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `scope_pk` | INTEGER PK | 数据库内部整数键；current 分区、counters、events 引用它 |
| `scope_id` | TEXT NOT NULL UNIQUE | 规范化 scope identity 的 SHA-256；对外稳定 ID |
| `source_pk` | INTEGER NOT NULL，FK | 所属 source |
| `partition_id` | INTEGER NOT NULL | manifest 中的固定物理分区 ID |
| `scope_key_json` | TEXT NOT NULL | 稳定键版本、算法和 keyHex |
| `scope_identity_json` | TEXT NOT NULL | 生成 `scope_id` 的完整 canonical identity |
| `scope_kind` | TEXT NOT NULL，CHECK | 仅 `peer` 或 `loc-rib` |
| `owner_key` | TEXT NULL | 聚合为 Session 或标识 Loc-RIB owner 的业务键 |
| `peer_type` | TEXT NULL | BMP Peer Type 的规范化展示值 |
| `peer_rd` | TEXT NULL | Peer Distinguisher / Instance RD |
| `peer_ip` | TEXT NULL | Peer IP；Loc-RIB scope 可空 |
| `peer_as` | TEXT NULL | Peer AS 的字符串表示，不是 INTEGER |
| `vrf_name` | TEXT NULL | VRF/Table Name |
| `afi` | INTEGER NOT NULL | Address Family Identifier |
| `safi` | INTEGER NOT NULL | Subsequent Address Family Identifier |
| `rib_type` | TEXT NOT NULL | Peer RIB stage，或 `loc-rib` |
| `current_epoch` | INTEGER NOT NULL，DEFAULT `0` | 当前全量刷新代次 |
| `eor_epoch` | INTEGER NULL | 最近完成 EOR 的 epoch |
| `scope_state` | TEXT NOT NULL，DEFAULT `syncing` | `syncing`、`ready`、`stale` 或 `down` |
| `stale_reason` | TEXT NULL | stale/down 原因 |
| `stale_since_ms` | INTEGER NULL | 开始 stale/down 的时间 |
| `refresh_started_ms` | INTEGER NULL | 当前刷新开始时间 |
| `cleanup_pending_epoch` | INTEGER NULL | 等待清理旧路径的 epoch |
| `last_connection_pk` | INTEGER NULL，FK | 当前接管 scope 的连接 |
| `created_at_ms` | INTEGER NOT NULL | Scope 创建时间 |
| `updated_at_ms` | INTEGER NOT NULL | Scope 最近更新时间 |

`UNIQUE(scope_pk, partition_id)` 为分区表的复合外键提供目标。Scope 的 insert/update trigger 还会根据固定 manifest 验证 `partition_id`、`scope_kind`、AFI 和 SAFI 的组合；一个 scope 的 `partition_id` 在其生命周期内必须稳定。

Peer scope 的 `rib_type` 应用约定如下；Loc-RIB 是独立的 RIB 视图，固定保存文本 `loc-rib`，不再细分 Pre/Post Adj-RIB-In/Out：

| 存储值 | 含义 |
| --- | --- |
| `1` | Pre-policy Adj-RIB-In |
| `2` | Post-policy Adj-RIB-In |
| `4` | Pre-policy Adj-RIB-Out |
| `5` | Post-policy Adj-RIB-Out |

`rib_type` 决定一个 peer scope 是哪个 RIB stage，但**不决定物理表**；物理表只由 `scope_kind + AFI + SAFI` 经 manifest 决定。因此同一 AF 的 Pre-In/Post-In/Pre-Out/Post-Out scope 会落在同一张 peer 分区表，用不同 `scope_id` 区分。

旧版本可能留下 `rib_type = '3'`。这是历史实现曾把 BMP Peer Header 的 `A` flag 错当成独立 RIB stage 的兼容数据；它不是标准 RIB 阶段。按 RFC 7854，`A` 只说明 UPDATE 使用 legacy 2-byte 还是 4-byte `AS_PATH` 编码，与 `L`（Pre/Post-policy）及 RFC 8671 的 `O`（Adj-RIB-In/Out）正交。当前摄入只由 `L + O` 生成 `1/2/4/5`，历史页可以只读展示值 `3`，但不会把它放入标准 RIB 阶段筛选项。

DDL 只对 `scope_kind` 声明枚举 `CHECK`。上述 `rib_type` 值和 `scope_state` 状态机由应用写入逻辑保证，表本身没有对应枚举 CHECK。

## 7. 全局路由对象

### 7.1 `bmp_route_identities`

该表保存“这是什么路由”，跨 source、scope 和 RIB stage 全局复用。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `route_pk` | INTEGER PK | 数据库内部短键，供分区和 event 引用 |
| `route_id` | TEXT NOT NULL UNIQUE | Canonical route identity 的稳定 SHA-256 ID |
| `route_key_version` | INTEGER NOT NULL | Route key schema version |
| `legacy_route_key` | TEXT NULL | 兼容页面/API 的旧 route key |
| `afi` | INTEGER NOT NULL | Address Family Identifier，也是分区验证依据 |
| `safi` | INTEGER NOT NULL | Subsequent Address Family Identifier，也是分区验证依据 |
| `path_id` | INTEGER NOT NULL | ADD-PATH Path Identifier |
| `rd` | TEXT NULL | VPN、EVPN、BGP-LS VPN 等 RD |
| `prefix` | TEXT NULL | 可索引的 IP 前缀或 parser 生成的复杂 NLRI 语义标识 |
| `prefix_length` | INTEGER NULL | IP 时是前缀长度；复杂 NLRI 时可能是协议编码长度，不能当作 CIDR Mask |
| `nlri_kind` | TEXT NULL | `ip-prefix`、`vpn-prefix`、`evpn`、`raw-nlri` 等 |
| `nlri_json` | TEXT NULL | 完整解析后的 NLRI；普通 IP 前缀（detail 只含 `pathId/prefix/length/rd/valid` 且与拆列一致）为 `NULL` |
| `nlri_flags` | INTEGER NOT NULL，DEFAULT `0` | `nlri_json` 为 `NULL` 时记录可选键：bit0 = `valid: true`，bit1 = 含 `rd` |
| `first_seen_ms` | INTEGER NOT NULL | Identity 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Identity 最近使用时间；仅供诊断，不再参与 GC |

页面返回的 `canonicalRouteKey`（`{schemaVersion, algorithm, keyHex}`）由 `route_key_version` 和 `route_id` 在读取时重建，不再单独存 `route_key_json`。

普通 IP 的 `prefix` 在新写入时会按地址族和 `prefix_length` 规范化为网络地址文本，避免等价 IPv6
因为零段压缩方式不同而精确查询漏项。历史查询仍会同时生成旧 v9 BMP 解析器使用的 IPv6 文本候选，
因此升级前已经保留的 identity 不需要重建数据库才能被搜索到。

`route_id` 的 canonical identity 包含 AFI、SAFI、ADD-PATH `path_id` 和规范化 NLRI。v13 起哈希输入是一条固定顺序的规范化字符串（`bmp-route|2|afi|safi|pathId|kind|…`，字段间用 U+001F 分隔）：IP/VPN/QP 前缀用网络地址 hex + 长度（VPN 另加规范化 RD），FlowSpec / BGP-LS / MVPN 等带原始字节的 NLRI 用 `routeType|rd|rawNlriHex`，EVPN 和其他结构化 NLRI 仍用解析字段（排除 label/VNI、path attribute 和展示字段）的排序 JSON。同一条路由从不同邻居、不同表示形式到达得到同一个 `route_id` 的语义与 v1 完全一致，只是哈希值不同。同一个 `route_id` 在多个 peer、RIB stage 或 Loc-RIB 中出现时只保存一份 identity/NLRI JSON；相同前缀但 `path_id` 不同则是不同 identity。

索引：

- `(prefix, prefix_length, route_pk)`：精确前缀/前缀范围反查；AFI/SAFI 由展开行或分区选择过滤，不再单独维护带 AFI/SAFI 前导列的第二个前缀索引。
- `(legacy_route_key, route_pk)`：旧 route key 查询。

### 7.2 `bmp_route_payloads`

该表不是完整 route snapshot，只保存不属于 identity/NLRI、Path Attributes 或 current-state 的扩展展示字段。写入前会删除 route key、AFI/SAFI、prefix、RD、path ID、`nlriDetail` 等 identity 字段，删除可从 `bmp_route_attributes` 取得的属性字段，删除 route state、epoch 和 stale 时间等 current-state 字段，并省略空值、空集合及可重建的默认值。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `payload_id` | INTEGER PK | 数据库内部短键 |
| `payload_hash` | BLOB NOT NULL UNIQUE | `route_json` 的 SHA-256 二进制内容哈希 |
| `route_json` | TEXT NOT NULL | 仅含扩展展示字段的 JSON object；允许为 `{}` |
| `first_seen_ms` | INTEGER NOT NULL | Payload 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Payload 最近使用时间 |

内容相同的 payload 在不同 route identity、scope、刷新和 event 之间共享一行。普通 IP prefix 路由如果没有额外展示字段，payload 就是 `{}`；所有这类 current row 和 route event 可以引用同一个 `payload_id`。

### 7.3 `bmp_route_attributes`

该表保存 canonicalized BGP Path Attributes。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `attr_pk` | INTEGER PK | 数据库内部整数键；current 分区和 events 引用它 |
| `attr_id` | TEXT NOT NULL UNIQUE | Canonical attribute JSON 的 SHA-256 ID |
| `attr_json` | TEXT NOT NULL | 去重后的属性 JSON |
| `first_seen_ms` | INTEGER NOT NULL | Attribute 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Attribute 最近使用时间 |

Identity、payload 和 attributes 分离后，route 更新属性时无需复制 NLRI；同一组属性也不会在数百万条 route 中重复保存。

当前 canonical `attr_json` 由应用写入的顶层字段是 `origin`、`asPath`、`med`、`localPref`、`communities`、`otc`、`nextHop` 和 `prefixSid`。这些是 JSON 内部字段，不是 SQLite 独立列；按 Next Hop 或 AS Path 搜索时需要解析/搜索 `attr_json`，页面读取则一次解析后覆盖到路由投影。

读取 current route 或 route event 时，应用按以下来源重建 route 投影：

1. `bmp_route_identities` 的 AFI/SAFI、prefix、RD、path ID 和 `nlri_json` 构造 identity/NLRI 基础字段及默认展示值，`nlri_json` 恢复为 `nlriDetail`。
2. `bmp_route_payloads.route_json` 叠加少量扩展展示字段；`{}` 不影响基础投影。
3. `bmp_route_attributes.attr_json` 叠加 canonical BGP Path Attributes，再由关联到的 `bmp_route_attributes.attr_id` 恢复 `attrId`。
4. Current-route 查询再从物理分区、scope 和 connection 补充 `routeState`、epoch、stale 原因和观察时间；event 查询则在 route 投影之外返回事件元数据。

### 7.4 对象回收（候选驱动 GC）

v10 起不再维护引用计数。identity、payload 和 attributes 的生命周期规则是：**只要还有任何 current row 引用它，就保留；否则可以删除。**

删除或替换 current row 是唯一会让对象失去引用的途径，所以回收由这些操作驱动：

| 动作 | 记录的候选 |
| --- | --- |
| Withdraw / purge 删除 current row（`DELETE ... RETURNING`） | 被删 current row 的 `route_pk`、`payload_id`、`attr_pk` |
| Announce 替换了已有 current row 的 payload/attribute | 旧的 `payload_id`、`attr_pk` |
| Sweep 删除旧 epoch/旧连接/过期 stale 的 current row | 被删 current row 的 `route_pk`、`payload_id`、`attr_pk` |
| 手动清理 stale 路由、删除 Source | 同上 |

候选先写入 Writer 连接的临时表 `temp.bmp_gc_candidates(kind, pk)`，然后在同一事务末尾执行三条反连接删除，例如：

```sql
DELETE FROM bmp_route_attributes
 WHERE attr_pk IN (SELECT pk FROM temp.bmp_gc_candidates WHERE kind = 3)
   AND NOT EXISTS (SELECT 1 FROM bmp_current_route_refs c WHERE c.attr_pk = bmp_route_attributes.attr_pk);
```

反连接走每张分区的 `attr` / `payload` / `route` 索引，因此代价与候选数成正比，而不是与全表大小成正比。

Announce/withdraw 的热路径只把键写入临时候选表，不执行反连接；真正的删除只在周期性 maintenance sweep、手动清理 stale 路由和删除 Source 时进行。候选表随 Writer 连接存在，重启后丢失的候选不会造成错误，只是对应对象要等到下一次被引用后再释放时才会被回收。

## 8. Current-route 分区表

36 张表使用同一结构：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `path_pk` | INTEGER PK | 当前路径行的短主键；只在这一张物理分区内唯一 |
| `partition_id` | INTEGER NOT NULL，固定 DEFAULT + CHECK | 该表固定 partition ID |
| `scope_pk` | INTEGER NOT NULL，复合 FK | 所属 scope |
| `route_pk` | INTEGER NOT NULL，FK | 指向全局 route identity |
| `payload_id` | INTEGER NOT NULL，FK | 指向全局 route payload |
| `attr_pk` | INTEGER NULL，FK | 指向全局 Path Attributes |
| `connection_pk` | INTEGER NOT NULL，FK | 当前版本来自哪次连接 |
| `rib_epoch` | INTEGER NOT NULL | 当前版本所属刷新 epoch |
| `explicit_state` | TEXT NOT NULL，DEFAULT `active` | 显式状态桶；DDL 无枚举 CHECK |
| `first_seen_ms` | INTEGER NOT NULL | 该 scope/path 首次出现时间 |
| `last_seen_ms` | INTEGER NOT NULL | 该 scope/path 最近出现时间 |
| `source_timestamp_ms` | INTEGER NULL | 最近 BMP source timestamp |
| `last_sequence` | INTEGER NOT NULL | 写入该版本的 mutation 在其连接内的序号；用于 upsert 版本保护，不用于页面排序 |

业务唯一约束为：

```text
UNIQUE(scope_pk, route_pk)
```

同一个 canonical route 可以出现在多个 scope；同一 scope 内只保留一个 current 版本。

当前 Writer 在 announce/replace/refresh upsert 时会把 `explicit_state` 写回 `active`。常见的 stale 并不是逐行把该列改成 `stale`，而是由 scope state、连接接管和 epoch 动态推导；这个字段仍保留在状态公式和 counter key 中，但不要把它误认为页面 `routeState` 的唯一来源。

`(scope_pk, partition_id)` 对 scope 使用 `ON DELETE CASCADE`。删除一个 scope 会自动删除它在所属 current 分区中的行，并由分区 delete trigger 同步减少 counter。

每张分区有五个二级索引：

| 索引后缀 | 字段 | 用途 |
| --- | --- | --- |
| `scope_first_seen` | `(scope_pk, first_seen_ms, path_pk)` | Scope 页面稳定分页 |
| `scope_epoch` | `(scope_pk, connection_pk, rib_epoch, path_pk)` | 接管、epoch 和 stale 清理 |
| `route` | `(route_pk, scope_pk)` | 跨 scope 定位同一路由、identity GC 反连接 |
| `attr` | `(attr_pk)` | 属性 GC 反连接和 FK 检查 |
| `payload` | `(payload_id)` | Payload GC 反连接和 FK 检查 |

v9 的 `connection` 索引已删除：没有查询只按连接定位 current row，`scope_epoch` 已包含 `connection_pk`。

分区 trigger 负责三类不变量：insert 时校验 scope、partition 和 family；update 时禁止改变 `scope_pk`、`partition_id`、`route_pk`；insert/delete 以及 `connection_pk`/`rib_epoch`/`explicit_state` 变化的 update 时在事务内维护 scope counter。

### 8.1 为什么分区表保持窄行

分区行不再保存 `route_identity_json`、`nlri_json`、`route_json` 或 `attr_json`。这样可以：

- 提高 B-tree 页扇出和缓存命中率；
- 缩小高频索引；
- 降低 upsert、withdraw 和 sweep 的写放大；
- 让全局重复对象只存一份。

## 9. Scope route counters

`bmp_scope_route_counts` 不是第二份路由表，而是 current 分区 trigger 维护的聚合桶。完整字段如下：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `scope_pk` | INTEGER NOT NULL，PK 部分，FK | 所属 scope；删除 scope 时 `ON DELETE CASCADE` |
| `connection_pk` | INTEGER NOT NULL，PK 部分，FK | 这些 current row 来自哪次 connection |
| `rib_epoch` | INTEGER NOT NULL，PK 部分 | 这些 current row 属于哪个刷新代次 |
| `explicit_state` | TEXT NOT NULL，PK 部分 | 分区行的显式状态桶；DDL 无枚举 CHECK |
| `route_count` | INTEGER NOT NULL，CHECK `>= 0` | 36 张分区中落入该桶的物理行数 |

复合主键是：

```text
(scope_pk, connection_pk, rib_epoch, explicit_state)
```

同一 scope 只属于一张分区，因此该 scope 的所有 counter 加总就等于其 current row 总数。分区 INSERT 会新建或 `+1`；DELETE 会 `-1` 并删除降到 0 的桶；connection、epoch 或 explicit state 改变时，UPDATE trigger 会把计数从旧桶搬到新桶。应用不直接写这张表。

该表用于避免拓扑恢复、Session/Instance 摘要和无路由级过滤的列表 `total` 执行 `COUNT(*)`。它不会替代列表行查询：页面仍要读取 scope 对应的 current 分区；存在 prefix、route key、搜索文本等过滤时，匹配后的 `total` 也会回退为带关联条件的 `COUNT(*)`。

有效状态仍由 scope 和路径组合计算：

```text
explicit_state = 'stale'
或 scope_state IN ('stale', 'down')
或 connection_pk IS NOT last_connection_pk
或 rib_epoch < current_epoch
    => stale

否则 => active
```

因此摘要可以从 counter 分组求得：

- `total`：该 scope 所有 counter 的总和。
- `active`：`explicit_state <> 'stale'`、属于当前 connection 且 epoch 不旧的 counter 总和，并受 scope state 约束。
- `stale`：`total - active`。

普通 Peer Down 或新 epoch 开始时仍只需更新 scope，不需要逐条改写 route。只有 reason 1/3
且携带结构完整 BGP Notification 的普通 peer Peer Down 会在推进 scope epoch 后立即清理该 peer
全部 AFI/SAFI/RIB scope 的 current route；它不会触碰 Loc-RIB。Loc-RIB 自己的 Peer Down 以及
普通 peer 不携带有效 Notification 的 Peer Down 继续保留 stale projection。

## 10. 批次幂等（v11 起没有路由事件表）

v11 删除了 `bmp_route_events`。数据库不再保存 announce / replace / withdraw / purge 的历史流水，页面上的“路由轨迹”和路由详情中的“事件轨迹”页签也随之移除。只保留：

- current RIB 投影（36 张分区 + 全局对象）；
- Statistics Report 样本和最新投影；
- `bmp_ingest_batches` 批次幂等记录。

去掉事件表带来的写入变化：每条路由少写 1 行 + 7 个索引，不再需要 `updateEventType` 和事件序列预查询；序列去重改由 `bmp_connections.last_sequence` 一次比较完成。

### 10.1 `bmp_ingest_batches`

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `batch_id` | TEXT PK | Persistence Client 生成的批次 ID |
| `created_at_ms` | INTEGER NOT NULL | 批次首次提交时间；用于按保留期清理 |
| `mutation_count` | INTEGER NOT NULL | 该批次携带的 mutation 数量 |

同一个 `batch_id` 重试时整批不会重复执行。批次记录与其他表之间没有关联，按 `created_at_ms` 独立清理。

一批中的 source、connection、scope、全局路由对象、current projection、counter、连接序号和 statistics 修改在一个 SQLite transaction 中提交。

## 11. Statistics tables

`bmp_statistics_samples` 保存历史样本：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `sample_id` | INTEGER PK AUTOINCREMENT | 全库递增样本 ID |
| `source_id` | TEXT NOT NULL，FK | 上报 source |
| `connection_id` | TEXT NOT NULL，FK | 上报连接 |
| `scope_id` | TEXT NULL，FK | 能归属到具体 RIB 时保存 scope；否则为空 |
| `report_kind` | TEXT NULL | 应用写入 `session` 或 `instance`；DDL 无枚举 CHECK |
| `report_key` | TEXT NULL | Session/Instance 逻辑报告键 |
| `observed_at_ms` | INTEGER NOT NULL | Collector 观察时间，也是历史保留判断时间 |
| `source_timestamp_ms` | INTEGER NULL | BMP 原始时间戳 |
| `statistics_json` | TEXT NOT NULL | 完整 Statistics Report JSON |

`bmp_statistics_latest` 是最新样本的小投影：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `source_id` | TEXT NOT NULL，PK 部分，FK | 报告所属 source |
| `report_kind` | TEXT NOT NULL，PK 部分，CHECK | 仅 `session` 或 `instance` |
| `report_key` | TEXT NOT NULL，PK 部分 | Session/Instance 逻辑报告键 |
| `sample_id` | INTEGER NOT NULL，FK | 指向当前最新 `bmp_statistics_samples.sample_id` |
| `observed_at_ms` | INTEGER NOT NULL | 冗余保存最新观察时间，用于比较是否应替换 latest |

`bmp_statistics_latest` 的主键是：

```text
(source_id, report_kind, report_key)
```

它引用每个逻辑 Session/Instance 报告的最新 sample。新样本只有在 `observed_at_ms` 更大，或时间相同而 `sample_id` 更大时，才替换 latest。统计页面读取该小投影并按 `sample_id` 回连历史表，不需要扫描全部历史样本。

只有 latest 表在 SQLite 层强制 `report_kind IN ('session', 'instance')`；samples 表允许 `NULL` 和其他文本，但正常应用写入仍遵守相同约定。`latest.sample_id` 也不是 UNIQUE：正常语义是一条 sample 对应至多一个 latest key，DDL 技术上允许多行 latest 指向同一 sample。DDL 也没有复合约束校验 latest 的 source/kind/key/time 与被引用 sample 完全一致，这项一致性由 Writer 保证。

## 12. 写入链路

```text
BMP 报文
   │
   ▼
BmpSession 构造 mutation
   │
   ▼
BmpPersistenceClient 有界队列
   │
   ▼
SQLite Writer transaction
   ├─ ingest batch 幂等
   ├─ source / connection upsert
   ├─ 解析 manifest 并 upsert scope.partition_id
   ├─ 拆分并 upsert 全局 route 对象
   │    ├─ identity + nlri_json
   │    ├─ 扩展展示 payload（普通路由可为 {}）
   │    └─ path attributes
   ├─ 用 connection.last_sequence 判定重放
   ├─ upsert/delete 一张 current-route 分区
   │    ├─ trigger 校验 family
   │    ├─ trigger 更新 scope counters
   │    └─ 被替换/删除的对象键记入 GC 候选
   ├─ 批末写回各连接的 last_sequence
   └─ statistics sample/latest（如有）
```

默认批量和背压参数：

| 参数 | 默认值 |
| --- | ---: |
| Batch size | 5000 mutations |
| Batch bytes | 16 MiB |
| Flush interval | 20 ms |
| High watermark | 64 MiB |
| Low watermark | 32 MiB |
| Stale/down scope aging retention | 24 小时 |
| Refresh timeout | 30 分钟 |
| Statistics 样本 / 批次记录 retention | 7 天 |
| 存储压力触发阈值 | 20 GiB |

20 GiB 不是 SQLite 文件硬上限，也不会保证文件大小被截断在 20 GiB。逻辑占用达到阈值时，Worker 会临时把 stale 和 statistics/批次的清理 cutoff 提前到当前时间，尽快清理 stale 路径、历史样本和零引用对象。健康 scope 中的 active 路由以及仍被 latest 引用的 statistics sample 不会仅因超过该阈值被删除，物理文件也不会自动缩小。

默认未开启 Route Assurance 时，Writer 不构造也不跨 Worker 回传完整 committed route delta；开启分析时在一次 writer fence 后启用 delta，用于衔接初始快照之后的增量变化。

页面列表、分页和详情查询从独立只读连接读取最新已提交的 WAL 快照，不等待持续增长的 Writer 队列。会话/实例列表和持久化路由查询会先等待一次 writer fence，但等待有上限（`persistenceReadFenceTimeoutMs`，默认 250 ms）：全表上报期间队列可能积压数万条 mutation，超时后直接读取已提交状态，页面在下一次路由更新事件时再刷新。因此高速摄入时页面可能短暂滞后于尚未提交的 batch，但不会读到半个事务。停止、删除、清理和 Route Assurance 初始快照边界仍执行无上限的 writer fence。只读连接失败时可回退 Writer；Writer 失败则停止 BMP 摄入。

## 13. Route 生命周期

### 13.1 Announce、replace 和 refresh

1. 解析并校验 scope 的物理 partition。
2. 将 route 拆成 identity/NLRI、扩展展示 payload 和 attributes 后分别 upsert；普通路由 payload 可以复用全局 `{}` 行。
3. 只有 mutation connection 等于 scope 当前 connection，且 epoch 等于 scope 当前 epoch，才允许更新 current projection。
4. 同一 `(scope_pk, route_pk)` 已存在时更新 payload、attribute、时间和 `last_sequence`，旧 payload/attribute 记入 GC 候选。
5. 根据是否新增、属性变化或仅刷新，把本次变更分类为 `announce`、`replace`、`refresh` 或 `upsert-noop`；该分类只出现在返回给 Worker 的 committed delta 中（供 Route Assurance 增量使用），不再落库。

### 13.2 Withdraw

1. Upsert/定位 route identity 和 payload。
2. 只有 connection 和 epoch 仍有效时，才从目标分区删除 current row。
3. Trigger 自动减少 scope count；被撤销路由的 identity/payload/attributes 记入 GC 候选，等待下一次 maintenance sweep 回收。
4. 旧 connection 或错误 epoch 不删除 current row，delta 分类为 `withdraw-noop`。

### 13.3 EOR 和旧 epoch

同一 BMP 连接内，重复上报某 AF 的 Peer Up（该 AF 的新一轮刷新）会推进该 AF scope 的 `current_epoch` 并进入 `syncing`；分批 Peer Up 中首次出现的新 AF 只打开自身 scope，不影响已经存在的其他 AF。Peer Down 已推进全部已跟踪 scope 的 epoch，因此其后的首个 Peer Up 复用该 epoch，不重复推进。若普通 peer 的 Peer Down reason 1/3 携带结构完整的 BGP Notification，旧 epoch 路由会立即从 current projection 删除（delta 原因为 `peer-down-notification:<reason>`）；其他 Peer Down 仍保留 stale 路由等待刷新、撤销或 sweep。EOR 将精确的 AF/RIB scope 设为 `ready`，记录 `eor_epoch` 并设置 `cleanup_pending_epoch`。

旧 connection/epoch 路径在删除前通过有效状态公式显示为 stale。Sweep 从 scope 对应的单一分区中分批删除旧路径，避免全库大事务。

如果新连接已经用 Peer Up 打开 scope、但一直没有 EOR，refresh timeout 到期后只保留该连接实际重新上报的路径，并删除旧 connection/epoch 路径。若同一设备重连后某个历史 scope 连 Peer Up 都没有再次出现，Collector 在确认该 source 只有一个更高代的在线连接后，也从新连接建立时间开始使用同一 refresh timeout 清空该 scope 的旧路径；scope 仍保持 `down`，不会伪装为在线或 `ready`。同一 source 存在多个并发在线连接时不执行这项整 scope 清理，避免不同 feed 互相删除。

## 14. 定时 sweep 和引用对象 GC

Worker 默认周期性执行小批量 sweep：

1. 找到需要清理的 scope。
2. 根据 scope 的 `partition_id` 只访问对应 current-route 表。
3. 分批删除旧 epoch、旧 connection 或超过 stale 保留期的路径。
4. 清理未被 latest 引用的旧 statistics sample 和旧 ingest batch。
5. 对累计的候选做反连接删除：仍被任何 current row 引用的候选保留，其余删除（见 7.4）。

这里有两个不同的时间口径：

- Stale retention 只控制已经 stale/down 的 scope 路径老化；EOR 已确认的旧 epoch 可以立即进入清理，不必再等 24 小时。
- `eventsBeforeMs`（沿用旧参数名）是未被 latest 引用的 statistics sample 和旧 ingest batch 的清理 cutoff；identity/payload/attributes 没有独立的时间口径，只要失去最后一个引用就会在下一次 maintenance sweep 中被回收。

除默认周期 sweep 外，Worker 会为最早的 scope refresh 维护单一 deadline timer；到期清理完成后，按受影响的 `source_id/scope_id` 发送路由刷新事件，使已打开的页面重新查询 SQLite，而不是继续显示清理前的列表缓存。

不要绕过 Writer 直接删除 current row：绕过 trigger 会让 scope counters 失真，绕过 Writer 的 `RETURNING` 收集会让被释放的对象错过回收（它们不会造成错误，但会一直占用空间）。

## 15. 正常停止与崩溃恢复

### 15.1 正常停止

正常停止会：

1. 关闭 BMP socket，不再接收新报文。
2. 写 connection close/scope down 状态。
3. Drain persistence queue。
4. 运行一次 sweep。
5. 执行 passive WAL checkpoint。
6. 关闭 reader 和 writer。

### 15.2 崩溃恢复

数据库重新打开时，遗留 `open` connection 会改为 `closed`，关闭原因为 `collector-restart`；其当前 scope 会进入 `down`。Current rows 不需要批量更新，通过 scope state 自动显示 stale。

## 16. Schema v13 初始化和版本规则

v13 不做任何数据迁移。Writer 打开数据库时按 `PRAGMA user_version` 判断：

| 情况 | Writer 行为 | Read-only 打开 |
| --- | --- | --- |
| `user_version = 13` 且对象完整 | 直接使用 | 直接使用 |
| `user_version = 13` 但缺表/缺列 | 记录警告，删除全部对象后重建空库 | 报缺失对象错误 |
| v1 到 v12 | 记录警告，删除全部对象后重建空库，随后 `VACUUM` 回收空间 | `BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE` |
| `user_version = 0` 但已有业务表、索引、view 或 trigger | 同上 | `BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE` |
| 高于 v13 | 同上 | `BMP_PERSISTENCE_SCHEMA_TOO_NEW` |
| 空库 | 初始化 | 报缺失对象错误 |

也就是说，BMP 启动后旧版本数据库会被原地清空并重建；SQLite 中的 current route 和 statistics 是 BMP 设备重连后会重新上报的投影，不需要人工干预。重建时先临时关闭 `foreign_keys`，避免 SQLite 在 DROP TABLE 时对旧 schema 做隐式 DELETE 校验，然后在一个事务里按 trigger → view → index → table 的顺序删除全部非内部对象，再执行正常初始化。

如需保留旧库用于审计，应在升级前停止 BMP 并备份整个 SQLite/WAL 文件组。旧 current route 和 statistics 不会自动导入。

## 17. 运维查询示例

建议停止 BMP 后执行人工一致性检查。运行中检查应使用 read-only 连接或 SQLite 在线备份能力。

### 17.1 Schema 和对象数量

```sql
PRAGMA user_version;
PRAGMA journal_mode;
PRAGMA foreign_key_check;

SELECT type, COUNT(*) AS objects
  FROM sqlite_master
 WHERE name NOT LIKE 'sqlite_%'
 GROUP BY type
 ORDER BY type;
```

### 17.2 各分区路由量

```sql
SELECT partition_id, COUNT(*) AS routes
  FROM bmp_current_routes_all
 GROUP BY partition_id
 ORDER BY partition_id;
```

### 17.3 Scope counters

```sql
SELECT s.scope_id, c.connection_id, count.rib_epoch, count.explicit_state, count.route_count
  FROM bmp_scope_route_counts count
  JOIN bmp_rib_scopes s ON s.scope_pk = count.scope_pk
  JOIN bmp_connections c ON c.connection_pk = count.connection_pk
 ORDER BY s.scope_id, c.connection_id, count.rib_epoch, count.explicit_state;
```

### 17.4 未被引用对象诊断

正常情况下这三个数字应接近 0；非零表示有对象绕过 Writer 被释放，等待下一次相关删除把它们带成候选，或可人工清理。

```sql
SELECT 'identity' AS kind, COUNT(*) AS unreferenced
  FROM bmp_route_identities i
 WHERE NOT EXISTS (SELECT 1 FROM bmp_current_route_refs c WHERE c.route_pk = i.route_pk)
UNION ALL
SELECT 'payload', COUNT(*)
  FROM bmp_route_payloads p
 WHERE NOT EXISTS (SELECT 1 FROM bmp_current_route_refs c WHERE c.payload_id = p.payload_id)
UNION ALL
SELECT 'attribute', COUNT(*)
  FROM bmp_route_attributes a
 WHERE NOT EXISTS (SELECT 1 FROM bmp_current_route_refs c WHERE c.attr_pk = a.attr_pk);
```

### 17.5 某 scope 的展开路由

```sql
SELECT s.scope_id, r.route_id, r.afi, r.safi, r.prefix, r.prefix_length,
       c.connection_id, r.rib_epoch, r.explicit_state, r.last_seen_ms,
       r.nlri_json, a.attr_json, r.route_json AS extension_payload_json
  FROM bmp_current_routes_all r
  JOIN bmp_rib_scopes s ON s.scope_pk = r.scope_pk
  JOIN bmp_connections c ON c.connection_pk = r.connection_pk
  LEFT JOIN bmp_route_attributes a ON a.attr_pk = r.attr_pk
 WHERE s.scope_id = ?
 ORDER BY r.first_seen_ms, r.path_pk
 LIMIT 100;
```

这里的 `extension_payload_json` 不是完整 route；应用读取会把 identity/NLRI、该 payload、attributes 和 current-state 合并成 route 投影。生产查询已知 scope 时应通过 manifest 直接命中一张物理表；统一 view 更适合诊断和真正的跨分区查询。

## 18. SQL 调试日志

在“设置 → 通用”中把日志级别切换为 `debug` 并保存后，BMP SQLite writer、只读 reader 和离线 reader 会输出 SQL 跟踪。切回 `info`、`warn`、`error` 或 `off` 会立即停止跟踪。

SQL 跟踪包括执行方式、耗时、受影响行数或返回行数，以及归一化后的 SQL。BMP 写入频率高，`debug` 会产生大量日志，只应临时启用。

## 19. 运维注意事项

- 不要手工向分区表写入错误的 `partition_id`，也不要绕过 family validation trigger。
- 不要手工修改 scope counters；不要绕过 Writer 删除 current row。
- 不要根据外部输入拼接物理表名，表名必须来自固定 manifest。
- 不要只备份 `bmp.sqlite3` 而忽略正在使用的 WAL/SHM。
- 最稳妥的离线备份方式是先停止 BMP，让队列 drain 并 checkpoint，再复制数据库文件。
- 大量删除后文件不会自动缩小；`freelist_count` 表示可复用页，是否执行 `VACUUM` 应由运维窗口和可用磁盘空间决定。
- `bmp_current_routes_all` 是只读统一视图，不应作为写入目标。
- v13 没有旧库兼容层；Writer 发现 schema 不匹配会直接清空并重建数据库，需要保留旧数据时必须在启动 BMP 之前备份。
