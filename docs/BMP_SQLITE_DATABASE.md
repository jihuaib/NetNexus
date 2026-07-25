# BMP SQLite 数据库说明

本文档说明 NetNexus BMP SQLite schema v9 的定位、固定路由分区、全局路由对象、引用计数、scope 计数，以及启动、写入、查询、清理和崩溃恢复行为。

如果目标是先理解页面怎么用、路由矩阵/路由追踪/路由轨迹有什么区别，以及详情和事件时间线长什么样，请先看带截图的 [BMP 监控器说明](BMP_MONITOR.md)；本文继续解释这些页面怎样关联 SQLite 表并组装字段。

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
| “这条路由以前发生过什么？” | `bmp_route_events` |

### 0.2 一条 current route 的关联键

已知页面选中的 `scope_id` 后，关联方向如下：

```text
bmp_rib_scopes.scope_id
  │
  ├─ partition_id ──> manifest ──> 选中一张 bmp_current_routes_* 表
  │                                      │
  │                                      ├─ route_pk   ──> bmp_route_identities.route_pk
  │                                      ├─ payload_id ──> bmp_route_payloads.payload_id
  │                                      ├─ attr_id    ──> bmp_route_attributes.attr_id
  │                                      └─ connection_id -> bmp_connections.connection_id
  │
  └─ source_id ──> bmp_sources.source_id
```

一条 current route 的业务唯一键是：

```text
(scope_id, route_pk)
```

它的含义是“在这个明确的 RIB 空间里，当前存在这个 canonical NLRI”。同一个 `route_pk` 可以同时出现在 Pre-In、Post-In 和 Loc-RIB 等多个 scope 中。

### 0.3 最容易混淆的 ID

| ID | 唯一范围 | 用途 | 页面/API 是否应直接使用 |
| --- | --- | --- | --- |
| `source_id` | 全库 | 稳定的 BMP 上报设备 ID；设备重连时复用 | 可用于查询和运维 |
| `connection_id` | 全库 | 某一次 TCP/BMP 连接 ID；每次重连新建 | 通常只用于诊断 |
| `scope_id` | 全库 | 稳定的逻辑 RIB ID；包含 source、Peer/Instance、AFI/SAFI、RIB stage | 页面查询路由的首选条件 |
| `partition_id` | 全库 manifest | 把 scope 定向到一张物理 current 分区表 | 不由外部输入自行推导 |
| `route_pk` | 全库 | SQLite 内部短整数键，供 current/event 高效关联 identity | 不作为稳定外部 ID |
| `route_id` | 全库 | canonical route identity 的稳定 SHA-256 ID | 可用于跨 scope 查同一 NLRI |
| `legacy_route_key` / 返回字段 `routeKey` | 某种路由 key 规则 | 兼容旧页面和详情查询的 opaque key | 页面只应原样回传，不应自行拆解 |
| `path_pk` | **仅在某一张分区表内** | current 物理行主键和稳定分页辅助键 | 跨分区时必须与 `partition_id` 一起看 |
| `attr_id` | 全库 | canonical Path Attributes JSON 的内容哈希 | 通常仅用于诊断 |
| `payload_id` | 全库 | 去重扩展 payload 的内部键 | 通常仅用于诊断 |
| `event_id` | 全库单调递增 | 事件顺序、时间线分页和 current 版本保护 | 可用于事件查询 |

字段后缀也有统一含义：

| 后缀/命名 | 含义 |
| --- | --- |
| `*_id` | 稳定业务 ID、内容 ID，或被引用对象的 ID；具体类型要看字段表 |
| `*_pk` | SQLite 内部整数短键，不承诺可跨库复用 |
| `*_ms` | Unix epoch 毫秒，不是格式化时间文本 |
| `*_epoch` | RIB 刷新代次，不是时间戳 |
| `*_json` | 序列化 JSON；查询后由应用解析并叠加到返回对象 |
| `*_ref_count` | Trigger 维护的引用数，不能由业务代码随意修改 |
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

| 物理分区 | scope 的 `rib_type` | `scope_id` | `route_pk` | `payload_id` | `attr_id` |
| --- | --- | --- | ---: | ---: | --- |
| `bmp_current_routes_peer_ipv4_unicast` | `1` = Pre Adj-RIB-In | `scope-pre-in` | 3 | 1 | `c8eada...` |
| `bmp_current_routes_peer_ipv4_unicast` | `2` = Post Adj-RIB-In | `scope-post-in` | 3 | 1 | `c8eada...` |
| `bmp_current_routes_loc_rib_ipv4_unicast` | `loc-rib` | `scope-loc-rib` | 3 | 1 | `c8eada...` |

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

第一步不是扫描 36 张表，而是用 `scope_id` 找到固定分区：

```sql
SELECT partition_id
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
           current.scope_id,
           current.route_pk,
           current.payload_id,
           current.attr_id,
           current.connection_id,
           current.rib_epoch,
           current.explicit_state,
           current.first_seen_ms,
           current.last_seen_ms,
           current.source_timestamp_ms,
           identity.route_id,
           identity.route_key_json,
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
           scope.source_id,
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
               OR route.connection_id IS NOT scope.last_connection_id
               OR route.rib_epoch < scope.current_epoch
             THEN 'stale'
             ELSE 'active'
           END AS effective_state
      FROM current_expanded AS route
      JOIN bmp_rib_scopes AS scope
        ON scope.scope_id = route.scope_id
      JOIN bmp_sources AS source
        ON source.source_id = scope.source_id
      JOIN bmp_connections AS connection
        ON connection.connection_id = route.connection_id
      LEFT JOIN bmp_route_attributes AS attributes
        ON attributes.attr_id = route.attr_id
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

`bmp_route_attributes` 使用 `LEFT JOIN`，因为某些 current route 观测没有可用 `attr_id`；identity 和 payload 是 current route 的必需对象，因此使用普通 `JOIN`。Withdraw 自身只写历史 event，并在有效 connection/epoch 下删除 current row，不会作为 current row 留在该查询里。

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
| `persistentScopeId` | current `scope_id` | 页面查询的逻辑 RIB 主键；详情对象保留 |
| `persistentSourceId` | `bmp_rib_scopes.source_id` | 稳定上报源 ID |
| `persistentConnectionId` | current `connection_id` | 该 current 版本来自的连接 ID |
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

### 0.8 列表、详情、Route Lens 和路由轨迹的查询差异

| 功能 | 主要查询条件 | 访问的 current 分区 | 最终返回 |
| --- | --- | --- | --- |
| Session 路由列表 | `scope_id + state + prefix + page` | 已知 scope，只访问 1 张 | 裁剪后的列表字段 + scope 摘要 |
| Loc-RIB 路由列表 | `scope_id + state + prefix + page` | 已知 scope，只访问 1 张 loc-rib 分区 | 裁剪后的列表字段 + scope 摘要 |
| 路由详情 | `scope_id + legacy_route_key` | 只访问 scope 所在的 1 张 | 完整组装对象；没有单独的 detail 表 |
| Route Lens | IP/CIDR/NLRI 查询 + state | 按 AFI/SAFI 剪枝；文本 NLRI 查询可能跨多分区 | 将同一查询的路由按五个 RIB stage 分组 |
| Route Assurance | 全量 current 快照 + 页面筛选 | 可跨多分区分页扫描 | 五阶段漏斗和异常候选 |
| 路由轨迹 | IP/CIDR 或 NLRI 语义标识 + Scope 类型 + RIB stage | 不查 current 分区；按保留事件中的 `(scope_id, route_pk)` 分组 | 每个 Scope 隔离的路由轨迹摘要，包含仍在 RIB 和已撤销/清理的路由 |
| 路由事件 | route/source/scope/type/time | 不查 current 分区；从 `bmp_route_events` 开始 | 事件元数据 + identity/payload/attributes 重建的当次路由 |

路由详情与列表复用同一套组装逻辑。详情查询只是把 `routeState` 设为 `all`，加上 `legacy_route_key` 精确条件并限制 `pageSize = 1`。

Session、Loc-RIB 和 Route Lens 的路由详情都提供“事件轨迹”页签。页面用当前路由的
`scope_id + route_id/routeKey` 调用 `getPersistedRouteEvents()`，按观察时间从新到旧分页展示
`announce / refresh / replace / withdraw / purge`，并比较相邻的可用属性快照，标出 Next Hop、
AS Path、Local Preference、MED 和 Community 等变化。这里必须带 `scope_id`：只用 `route_id`
会把同一 NLRI 在 Pre-In、Post-In、Loc-RIB 等不同 RIB 中的事件混到一起。
有稳定 `route_id` 时页面只使用 `scope_id + route_id`；只有详情尚未返回 `route_id` 时才回退到
`scope_id + routeKey`，两种 route identity 条件不会同时做 AND 查询。

这条轨迹是保留期内的规范化路由生命周期，不是原始 BMP/BGP 报文回放。`withdraw` 通常只有
NLRI identity、没有撤销前的 `attr_id`；这时撤销前属性要查看时间线上更早一次
`announce / replace / refresh`。如果 withdraw/purge 事件实际保留了 `attr_id`，页面会直接展示该
事件携带的撤销/清理前快照。`scope_stale`、`scope_eor` 等 scope 级事件不会混入单路由轨迹。

Session、Loc-RIB 和 Route Lens 的入口仍从 current-route 结果打开详情；成功 withdraw/purge 且未
重新宣告的路由不会再出现在这些入口中。`/bmp/route-history` 的“路由轨迹”页签同时查询仍在 RIB 和已离开 current RIB 的路由：
它调用 `getPersistedRouteEvents({ groupByRoute: true, ... })`，直接从保留事件按
`(scope_id, route_pk)` 聚合，所以 current 分区已经没有该路由时仍可检索。这里不能只按
`route_id` 分组，因为同一 NLRI 会同时出现在多个 Peer、RIB stage 或 Loc-RIB Scope 中。

页面对 IP/CIDR 使用 `prefixExact` 做规范化精确查询；对复杂 NLRI 使用 `prefix` 在
`bmp_route_identities.prefix` 上做从头匹配。这个字段对复杂 NLRI 保存 parser 生成的可读标识，例如：

- EVPN：`evpn:mac-ip:65000:41:tag=141:mac=aa:bb:cc:dd:ee:29:ip=192.0.2.51`
- BGP-LS：`bgp-ls:Link:10.250.0.1->10.250.0.2`
- FlowSpec：`dst=198.18.253.0/24; proto = 6; dst-port = 443`

因此可以输入完整标识，也可输入开头部分，例如 `evpn:mac-ip:` 或 `bgp-ls:`。复杂 NLRI 的
`prefix_length` 是 parser 长度元数据，不是 CIDR Mask，页面不会把它拼成 `/Mask`。

路由轨迹的 `total` 是 Scope 隔离后的**轨迹数**，不是事件数；每行的 `eventCount` 才是该轨迹在
当前保留窗口内的事件数。首屏查询会记录 `asOfEventId`，后续游标和打开的事件时间线都限定在这个
Event **摄入上界**内，避免新事件导致列表与抽屉的“最近事件”互相矛盾。这个上界不会冻结物理删除：
保留 sweep 或删除 Source 仍可能移除上界内的数据，所以它不是数据库快照。点击一行后使用该行的
`scope_id + route_id + asOfEventId` 查询事件时间线。

页面上的“最近保留事件”不等于当前状态；保留策略或磁盘压力可能裁掉更早事件，页面会同时展示
数据库当前最早保留的事件时间。空结果只表示“当前保留窗口内没有命中”，不表示该路由从未出现。

## 1. 数据库定位

SQLite 是 BMP RIB 的权威数据源，不是可选的历史副本。

- 完整 current RIB、路由事件和 Statistics Report 保存在 SQLite。
- 内存只保留在线连接、协议解析上下文、scope 元数据、少量摘要和页面增量状态。
- BGP Session、Loc-RIB Instance 和路由页面可在 BMP Worker 重启后从 SQLite 恢复。
- 数据库无法打开或 Writer 失败时，BMP 会 fail-closed，暂停继续接收数据，避免内存状态领先于数据库。

数据库基本信息：

| 项目 | schema v9 的值 |
| --- | --- |
| 数据库文件 | 通常为 Electron `userData/bmp/bmp.sqlite3` |
| Schema version | `9`，保存在 `PRAGMA user_version` |
| 稳定键 schema version | `1` |
| 稳定键算法 | SHA-256 |
| Journal 模式 | WAL |
| 外键 | `foreign_keys = ON` |
| 同步级别 | `synchronous = NORMAL` |
| Busy timeout | 5000 ms |
| 临时存储 | MEMORY |
| WAL 自动 checkpoint | 2000 页 |

WAL 模式运行时，数据库目录还可能存在：

- `bmp.sqlite3-wal`：尚未 checkpoint 回主文件的已提交 WAL 页面。
- `bmp.sqlite3-shm`：WAL 共享内存索引。

## 2. Schema v9 的核心变化

v9 不再把所有 current route 放在一张 `bmp_current_routes` 大表中。新的结构有四个重点：

1. current route 固定拆成 `2 × 18 = 36` 张物理分区表。
2. Route identity/NLRI、扩展展示 payload 和 path attributes 分开全局去重，分区表只保留当前路径状态和外键。
3. `current_ref_count`、`event_ref_count` 和 scope route counters 由 SQLite trigger 在事务内维护。
4. v9 只支持空库初始化，不包含 v8 或更早版本的数据迁移和兼容表。

这种设计把高频的 scope 内分页、upsert、withdraw 和 epoch 清理限制在一张较小的分区表中，同时避免把较大的 NLRI JSON、route JSON 和 attribute JSON 复制到每个 scope。

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
| `bmp_route_events` | 带固定分区归属的连接、scope、路由和统计事件流水 |
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

视图固定输出 27 列：

| 来源 | 输出字段 |
| --- | --- |
| Current 分区行（13 列） | `partition_id`、`path_pk`、`scope_id`、`route_pk`、`payload_id`、`attr_id`、`connection_id`、`rib_epoch`、`explicit_state`、`first_seen_ms`、`last_seen_ms`、`source_timestamp_ms`、`last_event_id` |
| Route identity（13 列） | `route_id`、`route_key_json`、`route_identity_json`、`route_key_version`、`legacy_route_key`、`afi`、`safi`、`path_id`、`rd`、`prefix`、`prefix_length`、`nlri_kind`、`nlri_json` |
| Route payload（1 列） | `route_json` |

它**不包含** `attr_json`、scope、source 或 connection 展示字段，这些仍需分别关联 `bmp_route_attributes`、`bmp_rib_scopes`、`bmp_sources` 和 `bmp_connections`。

该 view 主要用于真正的跨分区查询和运维检查。生产页面已知 `scope_id` 时，不会先扫这个 36 分区 view；查询代码会生成相同的 identity/payload 展开 SQL，但只针对 manifest 选中的 1 张物理表。

SQLite 还会自动创建 `sqlite_sequence`，用于记录 `bmp_route_events.event_id` 和 `bmp_statistics_samples.sample_id` 的 AUTOINCREMENT 进度。不要手工修改该表。

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
- 每张分区表的 `partition_id` 有固定值 `CHECK`，并通过 `(scope_id, partition_id)` 复合外键指向 `bmp_rib_scopes`。
- 分区 insert trigger 同时关联 scope 和 route identity，验证 scope 的 partition、kind、AFI/SAFI、identity 的 AFI/SAFI 与目标分区一致。
- 分区行一旦建立，`scope_id`、`partition_id` 和 `route_pk` 不可更新，避免绕过上述校验把路径移动到另一个 scope、分区或 identity。

## 5. 表关联图

```text
bmp_sources
  ├── 1:N ── bmp_connections
  ├── 1:N ── bmp_rib_scopes
  ├── 1:N ── bmp_route_events
  ├── 1:N ── bmp_statistics_samples
  └── 1:N ── bmp_statistics_latest

bmp_connections
  ├── 1:N ── bmp_rib_scopes.last_connection_id
  ├── 1:N ── 36 张 current-route 分区.connection_id
  ├── 1:N ── bmp_scope_route_counts.connection_id
  ├── 1:N ── bmp_route_events.connection_id
  └── 1:N ── bmp_statistics_samples.connection_id

bmp_rib_scopes
  ├── 1:N ── 所属的一张 current-route 分区
  ├── 1:N ── bmp_scope_route_counts
  ├── 1:N ── bmp_route_events.(scope_id, partition_id)，复合引用可整体为空
  └── 1:N ── bmp_statistics_samples.scope_id，可为空

bmp_route_identities
  ├── 1:N ── current-route 分区.route_pk
  └── 1:N ── bmp_route_events.route_pk

bmp_route_payloads
  ├── 1:N ── current-route 分区.payload_id
  └── 1:N ── bmp_route_events.payload_id

bmp_route_attributes
  ├── 1:N ── current-route 分区.attr_id，可为空
  └── 1:N ── bmp_route_events.attr_id，可为空

bmp_statistics_samples
  └── 应用通常 1:0..1 ── bmp_statistics_latest.sample_id
```

实际 JOIN/FK 列如下。看到同名的 `source_id` 或 `route_pk` 时，不需要猜关联方式：

| 子表字段 | 父表字段 | 数据库 FK | 删除行为/用途 |
| --- | --- | --- | --- |
| `bmp_connections.source_id` | `bmp_sources.source_id` | 是 | 默认 `NO ACTION` |
| `bmp_rib_scopes.source_id` | `bmp_sources.source_id` | 是 | 默认 `NO ACTION` |
| `bmp_rib_scopes.last_connection_id` | `bmp_connections.connection_id` | 是，可空 | 当前接管 scope 的连接 |
| `current.(scope_id, partition_id)` | `bmp_rib_scopes.(scope_id, partition_id)` | 是，复合 FK | `ON DELETE CASCADE` |
| `current.route_pk` | `bmp_route_identities.route_pk` | 是 | NLRI identity |
| `current.payload_id` | `bmp_route_payloads.payload_id` | 是 | 扩展展示 payload |
| `current.attr_id` | `bmp_route_attributes.attr_id` | 是，可空 | Path Attributes |
| `current.connection_id` | `bmp_connections.connection_id` | 是 | 当前版本来自哪次连接 |
| `bmp_scope_route_counts.scope_id` | `bmp_rib_scopes.scope_id` | 是 | `ON DELETE CASCADE` |
| `bmp_scope_route_counts.connection_id` | `bmp_connections.connection_id` | 是 | 计数桶所属连接 |
| `bmp_route_events.source_id` | `bmp_sources.source_id` | 是 | 事件所属 source |
| `bmp_route_events.connection_id` | `bmp_connections.connection_id` | 是 | 事件所属连接 |
| `bmp_route_events.(scope_id, partition_id)` | `bmp_rib_scopes.(scope_id, partition_id)` | 是，可整体为空 | 固定事件的逻辑 RIB 和物理分区 |
| `bmp_route_events.route_pk` | `bmp_route_identities.route_pk` | 是，可空 | 重建事件发生时的 NLRI identity |
| `bmp_route_events.payload_id` | `bmp_route_payloads.payload_id` | 是，可空 | 重建事件发生时的扩展 payload |
| `bmp_route_events.attr_id` | `bmp_route_attributes.attr_id` | 是，可空 | 重建事件发生时的 Path Attributes |
| `bmp_statistics_samples.source_id` | `bmp_sources.source_id` | 是 | 统计样本所属 source |
| `bmp_statistics_samples.connection_id` | `bmp_connections.connection_id` | 是 | 统计样本所属连接 |
| `bmp_statistics_samples.scope_id` | `bmp_rib_scopes.scope_id` | 是，可空 | 可选 RIB scope |
| `bmp_statistics_latest.source_id` | `bmp_sources.source_id` | 是 | 最新投影所属 source |
| `bmp_statistics_latest.sample_id` | `bmp_statistics_samples.sample_id` | 是 | 最新样本 |

只有表中明确写出的两条 `ON DELETE CASCADE` 会级联删除；其他 FK 使用 SQLite 默认的 `NO ACTION`。删除 source、connection 或全局路由对象前，应用必须先处理引用行。

`partition_id` 与 `scope_id` 一起重复保存在 current/event 中，是为了让数据库能用复合 FK 和 trigger 校验“这行确实属于该 scope 对应的固定分区”，并支持事件按分区剪枝；它不是另一套 scope ID。

有两条关联是应用有意不声明 FK：

- `bmp_route_events.batch_id -> bmp_ingest_batches.batch_id`：用于批次追踪和清理。
- `current.last_event_id -> bmp_route_events.event_id`：用于 upsert 版本保护，防止旧 event 覆盖新 current state；页面排序不使用它。

另外，`bmp_statistics_latest.sample_id` 只有普通 FK、没有 `UNIQUE`。正常写入语义是一条 sample 最多成为一个逻辑报告的 latest，但 DDL 本身允许多行 latest 引用同一 sample，因此图中的 `1:0..1` 是应用语义，不是 SQLite 强制基数。

## 6. Source、connection 和 scope

### 6.1 `bmp_sources`

一行代表一个稳定 BMP 上报源。完整字段：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `source_id` | TEXT PK | 规范化 source identity 的 SHA-256 十六进制值 |
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
| `connection_id` | TEXT PK | 单次 TCP/BMP 连接的全库 ID |
| `source_id` | TEXT NOT NULL，FK | 所属稳定 source，关联 `bmp_sources.source_id` |
| `connection_generation` | INTEGER NOT NULL | 应用生成的连接代次，用于新连接接管旧 scope |
| `local_ip` | TEXT NULL | Collector 本地地址 |
| `local_port` | INTEGER NULL | Collector 本地端口 |
| `remote_ip` | TEXT NULL | BMP 设备远端地址 |
| `remote_port` | INTEGER NULL | BMP 设备远端端口 |
| `opened_at_ms` | INTEGER NOT NULL | 连接打开时间 |
| `closed_at_ms` | INTEGER NULL | 连接关闭时间；在线时为空 |
| `close_reason` | TEXT NULL | 关闭原因 |
| `connection_state` | TEXT NOT NULL | 应用使用 `open` / `closed`；DDL 没有枚举 CHECK |

`connection_generation` 的单调性由 Writer 保证，数据库没有为它声明 UNIQUE。

`idx_bmp_connections_source_time(source_id, opened_at_ms DESC)` 用于查某 source 的连接历史。

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
| `scope_id` | TEXT PK | 规范化 scope identity 的 SHA-256 |
| `source_id` | TEXT NOT NULL，FK | 所属 source |
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
| `last_connection_id` | TEXT NULL，FK | 当前接管 scope 的连接 |
| `created_at_ms` | INTEGER NOT NULL | Scope 创建时间 |
| `updated_at_ms` | INTEGER NOT NULL | Scope 最近更新时间 |

`UNIQUE(scope_id, partition_id)` 为分区表的复合外键提供目标。Scope 的 insert/update trigger 还会根据固定 manifest 验证 `partition_id`、`scope_kind`、AFI 和 SAFI 的组合；一个 scope 的 `partition_id` 在其生命周期内必须稳定。

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
| `route_key_json` | TEXT NOT NULL | 稳定键版本、算法和 keyHex |
| `route_identity_json` | TEXT NOT NULL | 完整 canonical route identity |
| `route_key_version` | INTEGER NOT NULL | Route key schema version |
| `legacy_route_key` | TEXT NULL | 兼容页面/API 的旧 route key |
| `afi` | INTEGER NOT NULL | Address Family Identifier，也是分区验证依据 |
| `safi` | INTEGER NOT NULL | Subsequent Address Family Identifier，也是分区验证依据 |
| `path_id` | INTEGER NOT NULL | ADD-PATH Path Identifier |
| `rd` | TEXT NULL | VPN、EVPN、BGP-LS VPN 等 RD |
| `prefix` | TEXT NULL | 可索引的 IP 前缀或 parser 生成的复杂 NLRI 语义标识 |
| `prefix_length` | INTEGER NULL | IP 时是前缀长度；复杂 NLRI 时可能是协议编码长度，不能当作 CIDR Mask |
| `nlri_kind` | TEXT NULL | `ip-prefix`、`vpn-prefix`、`evpn`、`raw-nlri` 等 |
| `nlri_json` | TEXT NOT NULL | 完整解析后的 NLRI |
| `first_seen_ms` | INTEGER NOT NULL | Identity 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Identity 最近使用时间，也是历史 GC cutoff 的依据 |
| `current_ref_count` | INTEGER NOT NULL，DEFAULT `0`，CHECK `>= 0` | 36 张 current 分区中的引用数 |
| `event_ref_count` | INTEGER NOT NULL，DEFAULT `0`，CHECK `>= 0` | event 中的引用数 |

普通 IP 的 `prefix` 在新写入时会按地址族和 `prefix_length` 规范化为网络地址文本，避免等价 IPv6
因为零段压缩方式不同而精确查询漏项。历史查询仍会同时生成旧 v9 BMP 解析器使用的 IPv6 文本候选，
因此升级前已经保留的 identity 不需要重建数据库才能被搜索到。

`route_id` 的 canonical identity 包含 AFI、SAFI、ADD-PATH `path_id` 和规范化 NLRI。同一个 `route_id` 在多个 peer、RIB stage 或 Loc-RIB 中出现时只保存一份 identity/NLRI JSON；相同前缀但 `path_id` 不同则是不同 identity。

索引：

- `(afi, safi, prefix, prefix_length, route_pk)`：前缀查询。
- `(prefix, prefix_length, route_pk)`：已定向到 scope/分区后的精确前缀反查。
- `(legacy_route_key, route_pk)`：旧 route key 查询。
- `(current_ref_count, event_ref_count, last_seen_ms, route_pk)`：无引用对象清理。

### 7.2 `bmp_route_payloads`

该表不是完整 route snapshot，只保存不属于 identity/NLRI、Path Attributes 或 current-state 的扩展展示字段。写入前会删除 route key、AFI/SAFI、prefix、RD、path ID、`nlriDetail` 等 identity 字段，删除可从 `bmp_route_attributes` 取得的属性字段，删除 route state、epoch 和 stale 时间等 current-state 字段，并省略空值、空集合及可重建的默认值。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `payload_id` | INTEGER PK | 数据库内部短键 |
| `payload_hash` | BLOB NOT NULL UNIQUE | `route_json` 的 SHA-256 二进制内容哈希 |
| `route_json` | TEXT NOT NULL | 仅含扩展展示字段的 JSON object；允许为 `{}` |
| `first_seen_ms` | INTEGER NOT NULL | Payload 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Payload 最近使用时间 |
| `current_ref_count` | INTEGER NOT NULL，DEFAULT `0`，CHECK `>= 0` | current 分区引用数 |
| `event_ref_count` | INTEGER NOT NULL，DEFAULT `0`，CHECK `>= 0` | event 引用数 |

内容相同的 payload 在不同 route identity、scope、刷新和 event 之间共享一行。普通 IP prefix 路由如果没有额外展示字段，payload 就是 `{}`；所有这类 current row 和 route event 可以引用同一个 `payload_id`。

### 7.3 `bmp_route_attributes`

该表保存 canonicalized BGP Path Attributes。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `attr_id` | TEXT PK | Canonical attribute JSON 的 SHA-256 ID |
| `attr_json` | TEXT NOT NULL | 去重后的属性 JSON |
| `first_seen_ms` | INTEGER NOT NULL | Attribute 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Attribute 最近使用时间 |
| `current_ref_count` | INTEGER NOT NULL，DEFAULT `0`，CHECK `>= 0` | current 分区引用数 |
| `event_ref_count` | INTEGER NOT NULL，DEFAULT `0`，CHECK `>= 0` | event 引用数 |

Identity、payload 和 attributes 分离后，route 更新属性时无需复制 NLRI；同一组属性也不会在数百万条 route 中重复保存。

当前 canonical `attr_json` 由应用写入的顶层字段是 `origin`、`asPath`、`med`、`localPref`、`communities`、`otc`、`nextHop` 和 `prefixSid`。这些是 JSON 内部字段，不是 SQLite 独立列；按 Next Hop 或 AS Path 搜索时需要解析/搜索 `attr_json`，页面读取则一次解析后覆盖到路由投影。

读取 current route 或 route event 时，应用按以下来源重建 route 投影：

1. `bmp_route_identities` 的 AFI/SAFI、prefix、RD、path ID 和 `nlri_json` 构造 identity/NLRI 基础字段及默认展示值，`nlri_json` 恢复为 `nlriDetail`。
2. `bmp_route_payloads.route_json` 叠加少量扩展展示字段；`{}` 不影响基础投影。
3. `bmp_route_attributes.attr_json` 叠加 canonical BGP Path Attributes，再由 current/event 行的 `attr_id` 恢复 `attrId`。
4. Current-route 查询再从物理分区、scope 和 connection 补充 `routeState`、epoch、stale 原因和观察时间；event 查询则在 route 投影之外返回事件元数据。

### 7.4 引用计数

三张全局对象表都分别维护：

- `current_ref_count`：当前 36 张分区的引用数。
- `event_ref_count`：`bmp_route_events` 的引用数。

计数由 trigger 维护：

| 动作 | 自动变化 |
| --- | --- |
| 分区 INSERT | identity、payload，以及非空 attribute 的 current 引用 `+1` |
| 分区 DELETE | 对应 current 引用 `-1` |
| 分区 `payload_id` / `attr_id` UPDATE | 变化时旧引用 `-1`、新引用 `+1`；`route_pk` 不允许更新 |
| Event INSERT | 对应 event 引用 `+1` |
| Event DELETE | 对应 event 引用 `-1` |

引用字段比较使用 SQLite 的 NULL-safe `IS NOT`：可空的 `attr_id` 从 `NULL` 变为非空、从非空变为 `NULL`，或在两个 ID 之间切换时，计数都能正确更新；值未变化时不会重复增减。

只有 `current_ref_count = 0` 且 `event_ref_count = 0`，并早于 event/history retention cutoff 的对象才可被 GC。应用代码不应手工修正这些计数。

## 8. Current-route 分区表

36 张表使用同一结构：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `path_pk` | INTEGER PK | 当前路径行的短主键；只在这一张物理分区内唯一 |
| `partition_id` | INTEGER NOT NULL，固定 DEFAULT + CHECK | 该表固定 partition ID |
| `scope_id` | TEXT NOT NULL，复合 FK | 所属 scope |
| `route_pk` | INTEGER NOT NULL，FK | 指向全局 route identity |
| `payload_id` | INTEGER NOT NULL，FK | 指向全局 route payload |
| `attr_id` | TEXT NULL，FK | 指向全局 Path Attributes |
| `connection_id` | TEXT NOT NULL，FK | 当前版本来自哪次连接 |
| `rib_epoch` | INTEGER NOT NULL | 当前版本所属刷新 epoch |
| `explicit_state` | TEXT NOT NULL，DEFAULT `active` | 显式状态桶；DDL 无枚举 CHECK |
| `first_seen_ms` | INTEGER NOT NULL | 该 scope/path 首次出现时间 |
| `last_seen_ms` | INTEGER NOT NULL | 该 scope/path 最近出现时间 |
| `source_timestamp_ms` | INTEGER NULL | 最近 BMP source timestamp |
| `last_event_id` | INTEGER NOT NULL | 最新事件序号；逻辑引用，用于 upsert 版本保护，不用于页面排序 |

业务唯一约束为：

```text
UNIQUE(scope_id, route_pk)
```

同一个 canonical route 可以出现在多个 scope；同一 scope 内只保留一个 current 版本。

当前 Writer 在 announce/replace/refresh upsert 时会把 `explicit_state` 写回 `active`。常见的 stale 并不是逐行把该列改成 `stale`，而是由 scope state、连接接管和 epoch 动态推导；这个字段仍保留在状态公式和 counter key 中，但不要把它误认为页面 `routeState` 的唯一来源。

`(scope_id, partition_id)` 对 scope 使用 `ON DELETE CASCADE`。删除一个 scope 会自动删除它在所属 current 分区中的行，并由分区 delete trigger 同步减少 counter 和三类全局对象引用计数。

每张分区有六个二级索引：

| 索引后缀 | 字段 | 用途 |
| --- | --- | --- |
| `scope_first_seen` | `(scope_id, first_seen_ms, path_pk)` | Scope 页面稳定分页 |
| `scope_epoch` | `(scope_id, connection_id, rib_epoch, path_pk)` | 接管、epoch 和 stale 清理 |
| `route` | `(route_pk, scope_id)` | 跨 scope 定位同一路由 |
| `attr` | `(attr_id)` | 属性关联和诊断 |
| `payload` | `(payload_id)` | Payload 引用定位、删除诊断和引用完整性检查 |
| `connection` | `(connection_id, scope_id)` | 按连接清理或定位其 current route |

分区 trigger 负责三类不变量：insert 时校验 scope、partition 和 family；update 时禁止改变 `scope_id`、`partition_id`、`route_pk`；insert/delete/update 时事务内维护 scope counter 和全局对象的 current ref count。

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
| `scope_id` | TEXT NOT NULL，PK 部分，FK | 所属 scope；删除 scope 时 `ON DELETE CASCADE` |
| `connection_id` | TEXT NOT NULL，PK 部分，FK | 这些 current row 来自哪次 connection |
| `rib_epoch` | INTEGER NOT NULL，PK 部分 | 这些 current row 属于哪个刷新代次 |
| `explicit_state` | TEXT NOT NULL，PK 部分 | 分区行的显式状态桶；DDL 无枚举 CHECK |
| `route_count` | INTEGER NOT NULL，CHECK `>= 0` | 36 张分区中落入该桶的物理行数 |

复合主键是：

```text
(scope_id, connection_id, rib_epoch, explicit_state)
```

同一 scope 只属于一张分区，因此该 scope 的所有 counter 加总就等于其 current row 总数。分区 INSERT 会新建或 `+1`；DELETE 会 `-1` 并删除降到 0 的桶；connection、epoch 或 explicit state 改变时，UPDATE trigger 会把计数从旧桶搬到新桶。应用不直接写这张表。

该表用于避免拓扑恢复、Session/Instance 摘要和无路由级过滤的列表 `total` 执行 `COUNT(*)`。它不会替代列表行查询：页面仍要读取 scope 对应的 current 分区；存在 prefix、route key、搜索文本等过滤时，匹配后的 `total` 也会回退为带关联条件的 `COUNT(*)`。

有效状态仍由 scope 和路径组合计算：

```text
explicit_state = 'stale'
或 scope_state IN ('stale', 'down')
或 connection_id IS NOT last_connection_id
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

## 10. Route events 和批次

### 10.1 `bmp_route_events`

Event 表继续保持全局时间线，但不再重复保存 route JSON、AFI、SAFI、prefix 和 legacy key，而是引用全局 route 对象。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `event_id` | INTEGER PK AUTOINCREMENT | 全库递增事件 ID |
| `batch_id` | TEXT NOT NULL，无 FK | 所属 ingest batch，逻辑关联 `bmp_ingest_batches.batch_id` |
| `source_id` | TEXT NOT NULL，FK | 来源设备 |
| `connection_id` | TEXT NOT NULL，FK | 来源连接 |
| `source_sequence` | INTEGER NOT NULL | 连接内 mutation 序号 |
| `scope_id` | TEXT NULL，复合 FK | 可选 scope ID；与 `partition_id` 同空或同非空 |
| `partition_id` | INTEGER NULL，复合 FK | Event 所属固定分区；与 `scope_id` 共同引用 `bmp_rib_scopes` |
| `route_pk` | INTEGER NULL，FK | 可选 route identity |
| `payload_id` | INTEGER NULL，FK | 可选 route payload |
| `event_type` | TEXT NOT NULL | 事件最终分类；DDL 无枚举 CHECK |
| `observed_at_ms` | INTEGER NOT NULL | Collector 观察时间 |
| `source_timestamp_ms` | INTEGER NULL | BMP 原始时间戳 |
| `rib_epoch` | INTEGER NULL | 对应 RIB epoch |
| `attr_id` | TEXT NULL，FK | 可选 Path Attributes |
| `reason` | TEXT NULL | stale、close、purge 等原因 |

`scope_id` 和 `partition_id` 受 CHECK 约束，必须同时为 `NULL` 或同时非空；非空时通过 `(scope_id, partition_id)` 复合外键保证事件分区与 scope 分区一致。另一个 CHECK 只保证 `route_pk` 和 `payload_id` 同时为空或同时非空。

“Route event 带 route/payload，连接或 scope event 不带”是应用层按 `event_type` 保证的语义；DDL 没有把具体 `event_type` 与这对字段绑定，也没有给 `event_type` 声明枚举 CHECK。`UNIQUE(connection_id, source_sequence)` 保证同一连接内 mutation 重放幂等。

Event 创建后，`scope_id`、`partition_id`、`route_pk`、`payload_id` 和 `attr_id` 不可更新，确保分区归属、event ref count 与不可变的历史记录保持一致；需要不同引用时应写入新事件。

`idx_bmp_route_events_partition_time(partition_id, observed_at_ms DESC, event_id DESC)` 支持按分区和时间倒序读取历史。事件查询带 `scopeKind`、AFI 或 SAFI 条件时，会先通过固定 manifest 解析候选 `partition_id`，添加 `e.partition_id IN (...)` 进行剪枝，再用 scope/identity 的 AFI/SAFI 条件做最终精确过滤。AFI/SAFI 均给出时，已知 family 在指定 owner 下缩小到一个分区，未指定 owner 时缩小到 peer 和 loc-rib 两个分区；未知组合则命中相应 `other` 分区。

常见 `event_type`：

- 连接/source：`connection_open`、`source_update`、`connection_close`
- Scope：`scope_open`、`scope_stale`、`scope_eor`、`scope_timeout`
- Route：`announce`、`replace`、`refresh`、`upsert-noop`、`withdraw`、`withdraw-noop`、`purge`
- Statistics：`statistics`

### 10.2 `bmp_ingest_batches`

`bmp_ingest_batches` 保存 Writer 批次幂等记录：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `batch_id` | TEXT PK | Persistence Client 生成的批次 ID |
| `created_at_ms` | INTEGER NOT NULL | 批次首次提交时间；用于按 event retention 清理 |
| `mutation_count` | INTEGER NOT NULL | 该批次携带的 mutation 数量 |

同一个 `batch_id` 重试时整批不会重复执行。`bmp_route_events.batch_id` 与它是逻辑关联而非 FK，因此清理 batch 前会显式检查是否仍有 event 引用；索引 `created_at_ms` 支持按时间选取旧批次。

一批中的 source、connection、scope、全局路由对象、event、current projection、counter 和 statistics 修改在一个 SQLite transaction 中提交。

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
   ├─ insert event；带 scope 的事件同时写入 partition_id，trigger 更新 event_ref_count
   ├─ upsert/delete 一张 current-route 分区
   │    ├─ trigger 校验 family
   │    ├─ trigger 更新 scope counters
   │    └─ trigger 更新 current_ref_count
   └─ statistics sample/latest（如有）
```

默认批量和背压参数：

| 参数 | 默认值 |
| --- | ---: |
| Batch size | 2000 mutations |
| Batch bytes | 2 MiB |
| Flush interval | 20 ms |
| High watermark | 64 MiB |
| Low watermark | 32 MiB |
| Stale/down scope aging retention | 24 小时 |
| Refresh timeout | 30 分钟 |
| Event/历史对象 retention | 7 天 |
| 存储压力触发阈值 | 20 GiB |

20 GiB 不是 SQLite 文件硬上限，也不会保证文件大小被截断在 20 GiB。逻辑占用达到阈值时，Worker 会临时把 stale 和 event/history 的清理 cutoff 提前到当前时间，尽快清理 stale 路径、历史事件和零引用对象。健康 scope 中的 active 路由以及仍被 latest 引用的 statistics sample 不会仅因超过该阈值被删除，物理文件也不会自动缩小。

默认未开启 Route Assurance 时，Writer 不构造也不跨 Worker 回传完整 committed route delta；开启分析时在一次 writer fence 后启用 delta，用于衔接初始快照之后的增量变化。

页面列表、分页和详情查询从独立只读连接读取最新已提交的 WAL 快照，不等待持续增长的 Writer 队列。因此高速摄入时页面可能短暂滞后于尚未提交的 batch，但不会读到半个事务。停止、删除、清理和 Route Assurance 初始快照边界仍执行 writer fence。只读连接失败时可回退 Writer；Writer 失败则停止 BMP 摄入。

## 13. Route 生命周期

### 13.1 Announce、replace 和 refresh

1. 解析并校验 scope 的物理 partition。
2. 将 route 拆成 identity/NLRI、扩展展示 payload 和 attributes 后分别 upsert；普通路由 payload 可以复用全局 `{}` 行。
3. 插入 route event。
4. 只有 mutation connection 等于 scope 当前 connection，且 epoch 等于 scope 当前 epoch，才允许更新 current projection。
5. 同一 `(scope_id, route_pk)` 已存在时更新 payload、attribute、时间和 `last_event_id`。
6. 根据是否新增、属性变化或仅刷新，将 event 分类为 `announce`、`replace`、`refresh` 或 `upsert-noop`。

### 13.2 Withdraw

1. Upsert/定位 route identity 和 payload，并写 event。
2. 只有 connection 和 epoch 仍有效时，才从目标分区删除 current row。
3. Trigger 自动减少 scope count 和 current reference counts。
4. 旧 connection 或错误 epoch 不删除 current row，event 分类为 `withdraw-noop`。

### 13.3 EOR 和旧 epoch

同一 BMP 连接内，重复上报某 AF 的 Peer Up（该 AF 的新一轮刷新）会推进该 AF scope 的 `current_epoch` 并进入 `syncing`；分批 Peer Up 中首次出现的新 AF 只打开自身 scope，不影响已经存在的其他 AF。Peer Down 已推进全部已跟踪 scope 的 epoch，因此其后的首个 Peer Up 复用该 epoch，不重复推进。若普通 peer 的 Peer Down reason 1/3 携带结构完整的 BGP Notification，旧 epoch 路由会立即以 `peer-down-notification:<reason>` 原因写入 `purge` 历史并从 current projection 删除；其他 Peer Down 仍保留 stale 路由等待刷新、撤销或 sweep。EOR 将精确的 AF/RIB scope 设为 `ready`，记录 `eor_epoch` 并设置 `cleanup_pending_epoch`。

旧 connection/epoch 路径在删除前通过有效状态公式显示为 stale。Sweep 从 scope 对应的单一分区中分批删除旧路径，避免全库大事务。

如果新连接已经用 Peer Up 打开 scope、但一直没有 EOR，refresh timeout 到期后只保留该连接实际重新上报的路径，并删除旧 connection/epoch 路径。若同一设备重连后某个历史 scope 连 Peer Up 都没有再次出现，Collector 在确认该 source 只有一个更高代的在线连接后，也从新连接建立时间开始使用同一 refresh timeout 清空该 scope 的旧路径；scope 仍保持 `down`，不会伪装为在线或 `ready`。同一 source 存在多个并发在线连接时不执行这项整 scope 清理，避免不同 feed 互相删除。

## 14. 定时 sweep 和引用对象 GC

Worker 默认周期性执行小批量 sweep：

1. 找到需要清理的 scope。
2. 根据 scope 的 `partition_id` 只访问对应 current-route 表。
3. 分批删除旧 epoch、旧 connection 或超过 stale 保留期的路径。
4. 分批删除超过事件保留期的 event；event delete trigger 自动减少 event 引用。
5. 清理未被 latest 引用的旧 statistics sample 和旧 ingest batch。
6. 删除 `current_ref_count = 0 AND event_ref_count = 0` 且超过保留期的 identity、payload 和 attributes。

这里有两个不同的时间口径：

- Stale retention 只控制已经 stale/down 的 scope 路径老化；EOR 已确认的旧 epoch 可以立即进入清理，不必再等 24 小时。
- Event retention 的 `eventsBeforeMs` 同时作为旧 event、未被 latest 引用的 statistics sample、无 event 引用的 ingest batch，以及零引用 identity/payload/attributes 的历史清理 cutoff。

除默认周期 sweep 外，Worker 会为最早的 scope refresh 维护单一 deadline timer；到期清理完成后，按受影响的 `source_id/scope_id` 发送路由刷新事件，使已打开的页面重新查询 SQLite，而不是继续显示清理前的列表缓存。

删除 current row 和 event 后不要绕过 trigger，否则引用计数和 scope counters 会失真。

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

## 16. Schema v9 初始化和版本规则

v9 明确不支持旧库迁移。

Writer 只接受以下两种数据库：

1. 已经是完整 schema v9 的数据库。
2. `PRAGMA user_version = 0` 且没有任何非 SQLite 内部对象的空数据库。

其他情况直接失败：

| 情况 | 结果 |
| --- | --- |
| v1 到 v8 | `BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE` |
| `user_version = 0` 但已有业务表、索引、view 或 trigger | `BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE` |
| 高于 v9 | `BMP_PERSISTENCE_SCHEMA_TOO_NEW` |
| Read-only 打开非 v9 | 拒绝读取 |

不能通过手工把旧库 `user_version` 改成 0 来升级，因为初始化还会检查数据库是否为空。

升级到使用 v9 的版本前，如需保留旧库用于审计，应先停止 BMP 并备份整个 SQLite/WAL 文件组；应用使用 v9 时需要创建新的空数据库。旧 current route、event 和 statistics 不会自动导入。

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
SELECT scope_id, connection_id, rib_epoch, explicit_state, route_count
  FROM bmp_scope_route_counts
 ORDER BY scope_id, connection_id, rib_epoch, explicit_state;
```

### 17.4 引用计数诊断

```sql
SELECT 'identity' AS kind, COUNT(*) AS unreferenced
  FROM bmp_route_identities
 WHERE current_ref_count = 0 AND event_ref_count = 0
UNION ALL
SELECT 'payload', COUNT(*)
  FROM bmp_route_payloads
 WHERE current_ref_count = 0 AND event_ref_count = 0
UNION ALL
SELECT 'attribute', COUNT(*)
  FROM bmp_route_attributes
 WHERE current_ref_count = 0 AND event_ref_count = 0;
```

### 17.5 某 scope 的展开路由

```sql
SELECT r.scope_id, r.route_id, r.afi, r.safi, r.prefix, r.prefix_length,
       r.connection_id, r.rib_epoch, r.explicit_state, r.last_seen_ms,
       r.nlri_json, a.attr_json, r.route_json AS extension_payload_json
  FROM bmp_current_routes_all r
  LEFT JOIN bmp_route_attributes a ON a.attr_id = r.attr_id
 WHERE r.scope_id = ?
 ORDER BY r.first_seen_ms, r.path_pk
 LIMIT 100;
```

这里的 `extension_payload_json` 不是完整 route；应用读取会把 identity/NLRI、该 payload、attributes 和 current-state 合并成 route 投影。生产查询已知 scope 时应通过 manifest 直接命中一张物理表；统一 view 更适合诊断和真正的跨分区查询。

## 18. SQL 调试日志

在“设置 → 通用设置”中把日志级别切换为 `debug` 并保存后，BMP SQLite writer、只读 reader 和离线 reader 会输出 SQL 跟踪。切回 `info`、`warn`、`error` 或 `off` 会立即停止跟踪。

SQL 跟踪包括执行方式、耗时、受影响行数或返回行数，以及归一化后的 SQL。BMP 写入频率高，`debug` 会产生大量日志，只应临时启用。

## 19. 运维注意事项

- 不要手工向分区表写入错误的 `partition_id`，也不要绕过 family validation trigger。
- 不要手工修改 scope counters 或任何 ref-count 字段。
- 不要根据外部输入拼接物理表名，表名必须来自固定 manifest。
- 不要只备份 `bmp.sqlite3` 而忽略正在使用的 WAL/SHM。
- 最稳妥的离线备份方式是先停止 BMP，让队列 drain 并 checkpoint，再复制数据库文件。
- 大量删除后文件不会自动缩小；`freelist_count` 表示可复用页，是否执行 `VACUUM` 应由运维窗口和可用磁盘空间决定。
- `bmp_current_routes_all` 是只读统一视图，不应作为写入目标。
- v9 没有旧库兼容层；发现 schema 不匹配时应备份旧库并创建空库，不要直接修改 `user_version` 或表结构。
