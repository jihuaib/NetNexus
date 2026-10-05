# BMP SQLite 数据库说明

本文档说明 NetNexus BMP 按 client 独立存储的 SQLite schema v14、固定路由分区、库内共享路由对象、整数代理键、持久候选驱动的对象回收、scope 计数，以及启动、写入、查询、清理和崩溃恢复行为。

## 按 client 隔离的存储布局

`persistenceDbPath` 是存储定位基址，不再是所有 client 共用的路由数据库。每个稳定 `source_id` 对应一个完整的独立数据库：

```text
bmp/bmp.sqlite3.clients/<source_id>.sqlite3
```

每个文件独立保存 source、connection、scope、所有地址族的路由、属性、payload 和统计数据。相同 NLRI 或相同属性出现在不同 client 时，分别在各自的文件中保存；属性去重、引用计数、回收、撤销和 epoch 清理均不跨 client。本文后续的“全库”和“全局对象”仅指某一个 client 数据库内部，整数代理键不能跨文件使用。

client 归属由稳定 source identity 决定，不采用临时 TCP 源端口或连接 UUID，因此同一键版本内重连复用原文件。当前稳定键版本为 3；source、scope 和 route 的键版本一起升版，EVPN 路由键按 RFC 字段修正（见 7.1）。不按 IP、EVPN Route Type、FlowSpec 组件等再拆数据库；已有地址族物理分表保持不变。不迁移旧键或保留旧 schema 兼容层。

BMP 的 `threadCount` 默认是 4，范围为 1–16。它同时设置解析 worker 数和持久化 Writer 数；一个解析槽在整个连接生命周期内只服务一条 BMP 连接，因此最多同时接入 `threadCount` 条 BMP 连接。槽位已满时，新连接立即关闭，不排队等待。断线关闭操作与该连接已有的数据保持 FIFO，完成解析和会话关闭后才释放槽；重连重新占用空闲槽，但仍按稳定 source identity 复用原 client 数据库。连接上限不限制历史 client 的数量。

启用持久化时，可以把执行模型简化为：

```text
socket / 启停 / 查询协调线程
  ├─ N 个解析 worker：每条在线 BMP 连接独占一个槽，解析 BMP/BGP 和生成 mutation
  ├─ N 个数据库 Writer：按稳定 source ID 固定分配，写入各 client 的独立 SQLite 文件
  └─ 共享查询 Reader：按 source 定位单库，或聚合发现到的 client 数据库

N = threadCount，默认 4，范围 1–16
```

socket 接收和业务协调仍在协调线程，不是每条 TCP 连接独立运行整个 BMP 服务，也不把一条连接的路由拆给多个解析线程。每个 Writer 可管理多个 client 的独立文件；同一 client 的写入和生命周期事件保持 FIFO，跨 client 可以并行。停止服务会等待连接关闭、解析队列和持久化队列完成，再关闭数据库及 worker。此模型增加的是多连接解析与写入并行能力，不承诺单 client 的解析或单库写入吞吐按 N 倍增长。

解析线程异常会停止 BMP、通知界面并清理 worker，不继续接收数据或自动迁移会话。重新启动时，沿用数据库已有的中断连接恢复流程。删除离线 client 前，会先等待尚未完成的解析和连接关闭，再等待数据库写入屏障，避免延迟 mutation 重新写回已删除的数据。

读线程发现分库目录，按 source 定位查询；全局路由分页的 opaque cursor 同时记录 client 和库内位置。Route Assurance 按 client 依次流式读取，仍保持每个 client 内的 NLRI 分组顺序；按需启动的分析 reader 不计入上述 N 个解析槽或 N 个 Writer。

首次创建先在私有临时目录完成 schema 初始化并关闭 SQLite，再原子发布正式文件，避免读线程看到未初始化的库。每个 worker 的打开数据库缓存有上限，重新打开被驱逐的连接不会被误判为 collector 重启。

删除单个 client 时清空该库的路由、属性和其它记录，但保留空文件，使已经打开的 reader 不会继续持有旧 inode。服务停止后的“删除 BMP 数据库”操作才关闭 reader 并删除所有合法 client 数据库及其 sidecar；未知文件和旧共享库不在此手动删除范围。应用启动时统一检查旧共享 `bmp.sqlite3` 与全部 client 库的 SQLite `user_version`：当前 schema v14 保留，不同版本删除该主库及其 `-wal`、`-shm`、`-journal`，不迁移数据。旧共享库不参与当前分库查询，设置页不再展示旧库提示。离线查询始终只读，不清理、升级或重建数据库。

验证覆盖真实多 Writer 交错写入及 fence、相同 NLRI/属性的物理隔离、EVPN/FlowSpec、单 client 更新/撤销/删除、重连/EOR、分页游标、LRU 和离线恢复。另有强制 Node-fork 回归：同一进程两轮真实 BMP 启动、收路由、Route Assurance、停止和离线读取，检查正常退出码及无退出信号。此轮未做单 client 千万路由写入吞吐压测。

Electron `ELECTRON_RUN_AS_NODE` 的 Node-fork 兜底路径使用 JSON IPC 和 `electron/worker/core/protocolProcessSerialization.js` 的纯 JS 图编码，保留 Buffer、TypedArray、特殊数值、Map/Set、Date、循环及重复引用。这避开了当前 Electron 运行时对复杂对象执行 V8 序列化时的 BackingStore 回收崩溃；不能用 `v8.serialize()` 再包 base64 替代，因为序列化本身也能复现该崩溃。标准 `utilityProcess`、进程内 worker-thread 和普通 Node 的高级 IPC 通道保持原样。

如果目标是先理解页面怎么用、路由矩阵/路由追踪有什么区别，以及详情长什么样，请先看带截图的 [BMP 监控器说明](BMP_MONITOR.md)；本文继续解释这些页面怎样关联 SQLite 表并组装字段。

实现依据：

- Schema、事务、查询和清理：`electron/worker/bmp/bmpPersistenceStore.js`
- client 文件定位、安全检查和分库查询：`electron/worker/bmp/bmpClientPersistencePaths.js`、`bmpClientPersistenceStore.js`
- 有界 Writer 池、跨线程 fence 和水位：`electron/worker/bmp/bmpClientPersistenceClient.js`
- 每连接独占解析槽和 FIFO 关闭：`electron/worker/bmp/bmpIngestClientPool.js`
- 固定分区清单和安全路由：`electron/worker/bmp/bmpRoutePartitionManifest.js`
- 稳定 source、scope、route ID：`electron/utils/bmp/bmpPersistentRouteKey.js`
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
| “前缀、RD、Path ID、canonical NLRI 是什么？” | `bmp_route_identities` |
| “Next Hop、AS Path、MED、Community 是什么？” | `bmp_route_attributes` |
| “这条路径的完整 NLRI、Label、解析注解、Path Marking、Route TLV 是什么？” | `bmp_route_payloads`（普通 IP NLRI 可由 identity 列重建） |
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

事实表（current 分区、`bmp_scope_route_counts`）只保存整数代理键；64 字符 hex 的 `source_id`、`scope_id`、`attr_id` 和 UUID `connection_id` 只在各自维表里出现一次。这样每个索引条目从几十到上百字节缩到 8 字节，是 v10 写入吞吐和库体积改善的主要来源。

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
| `route_pk` | 全库 | SQLite 内部短整数键，供 current 高效关联 identity | 不作为稳定外部 ID |
| `route_id` | 全库 | canonical route identity 的稳定 SHA-256 ID | 可用于跨 scope 查同一 NLRI |
| `legacy_route_key` / 返回字段 `routeKey` | 某一 source + scope 内 | 现有列保存完整 NLRI lookup key，字段名不表示旧 key 兼容 | scope 内唯一；页面、事件匹配和详情查询原样回传，不自行拆解 |
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
nlri_json = NULL
nlri_flags = 3（读取时重建 pathId/prefix/length/rd/valid）
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

因此，三个 RIB 各自保存“我当前包含 route 3”，但 canonical identity 和相同的 Path Attributes 不需要复制三份。复杂 NLRI 的完整解析对象属于每条路径的 payload，可保留不同邻居或阶段的 label、ESI、Gateway、原始编码和解析注解；内容完全相同的 payload 仍可去重。

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

`bmp_route_attributes` 使用 `LEFT JOIN`，因为某些 current route 观测没有可用 `attr_pk`；identity 和 payload 是 current route 的必需对象，因此使用普通 `JOIN`。Withdraw 在有效 connection/epoch 下删除 current row，不保留历史 event，也不会作为 current row 留在该查询里。

### 0.7 SQL 行如何组装成页面路由

SQL 查出一个展开行后，`buildStoredRouteProjection()` 按以下顺序组装路由：

```text
1. identity 列 + nlri_flags
   -> afi, safi, ip, mask, rd, pathId, routeKey；普通 IP NLRI 可由拆列重建

2. payload.route_json 覆盖少量扩展字段
   -> 完整 nlriDetail（如有）、labels, rdRaw, routeType/rawNlri、Path Marking、routeTlvs、parseStatus ...

3. attributes.attr_json 覆盖 BGP Path Attributes
   -> origin, asPath, nextHop, localPref, med, communities, otc, prefixSid ...

4. current row + scope + connection + source 补充持久化状态
   -> routeState, staleReason, ribEpoch, scopeState, ribType, peer, source,
      firstSeenAt, lastSeenAt, sourceTimestampMs ...
```

主要页面字段来源：

| 返回/页面字段 | 数据来源 | 备注 |
| --- | --- | --- |
| `routeKey` | `bmp_route_identities.legacy_route_key` | 页面行键、事件匹配和详情查询原样回传 |
| `persistentRouteId` | `bmp_route_identities.route_id` | 内部稳定 canonical route ID；详情对象保留，普通列表会裁掉 |
| `persistentScopeId` | `bmp_rib_scopes.scope_id`（经 current `scope_pk` 关联） | 页面查询的逻辑 RIB 主键；详情对象保留 |
| `persistentSourceId` | `bmp_sources.source_id`（经 scope 的 `source_pk` 关联） | 稳定上报源 ID |
| `persistentConnectionId` | `bmp_connections.connection_id`（经 current `connection_pk` 关联） | 该 current 版本来自的连接 ID |
| `afi` / `safi` | `bmp_route_identities` | 同时用于分区校验 |
| `ip` / `mask` | `prefix` / `prefix_length` | 复杂 NLRI 可能为 `NULL` |
| `rd` / `pathId` | `bmp_route_identities` | 属于 canonical route identity |
| `rdRaw` | `route_json.rdRaw` 或其中 `nlriDetail.rdRaw` | 保留原始 RD 编码 |
| `nlriDetail` | `bmp_route_payloads.route_json.nlriDetail`；普通 IP 由 identity 列及 `nlri_flags` 重建 | EVPN、MVPN、BGP-LS 等完整结构及非键注解属于当前路径，不跨 peer/stage 串用 |
| `origin` / `asPath` / `nextHop` / `localPref` / `med` / `communities` | `bmp_route_attributes.attr_json` | 同一组属性跨路由共享 |
| `routeType` / `rawNlri` | `bmp_route_payloads.route_json.nlriDetail` 或 payload 顶层字段 | 当前路径的 NLRI 类型/原始字节 |
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
| 路由详情 | `source_id + scope_id + routeKey` | 只访问 scope 所在的 1 张 | 完整组装对象；没有单独的 detail 表 |
| Route Lens | IP/CIDR/NLRI 查询 + state | 按 AFI/SAFI 剪枝；文本 NLRI 查询可能跨多分区 | 将同一查询的路由按五个 RIB stage 分组 |
| Route Assurance | 全量 current 快照 + 页面筛选 | 可跨多分区分页扫描 | 五阶段漏斗和异常候选 |

路由详情与列表复用同一套组装逻辑。详情查询把 `routeState` 设为 `all`，在已校验的 source 和 scope 内按列表返回的 `routeKey` 精确匹配，并限制 `pageSize = 1`。页面、IPC 和外部 API 不需要额外的 route ID 参数。

`routeKey` 表达完整 NLRI 身份，页面只负责原样回传：

- 普通 IP：`pathId|RD|networkPrefix|prefixLength`，例如 `0|0:0|203.0.113.0|24`。
- QP：`pathId|RD|qp:AFI:networkPrefix/prefixLength;dqpn=value/bits`。prefix-only 使用 `dqpn=absent`；显式零值使用 `dqpn=0/0`。相同前缀、不同 DQPN 值或位数有不同 key。
- EVPN、FlowSpec、BGP-LS 等复杂 NLRI：`pathId|RD|AFI:SAFI:kind:canonicalNLRI`，最后一段包含完整 canonical NLRI 结构；内部 `|` 转义，避免分隔歧义。EVPN RT2 的标签、RT5 的网关等非身份载荷变化不会改变 key。

详情调用若只提供路由对象而没有 `routeKey`，服务端使用其地址族和完整 NLRI 生成同一 key；复杂地址族缺少 NLRI 时明确报错，不用展示前缀猜测。64 字符数据库 ID 不作为 `routeKey` 的别名。

CLI 仍使用原来的 `route-key` 参数；复杂 key 含 JSON 双引号时，将整个 key 放在单引号内原样传入，避免命令分词改变其中的引号。

HTTP `routeKey` 长度上限为 256 KiB，容纳完整 raw NLRI 的十六进制 key；超过上限的输入在数据库查询前拒绝。仅 `/api/v1/bmp/routes/detail`、`/api/v1/bmp/instances/routes/detail` 和 `/api/v1/bmp/persistence/routes` 使用 512 KiB 请求体额度，其余 API 保持原 64 KiB 上限。

数据库只保存 current 投影：成功 withdraw/purge 且未重新宣告的路由会从分区表删除，之后没有任何页面或 API 能再查到它。v11 起没有路由事件表，也没有“路由轨迹/事件轨迹”功能。

复杂 NLRI 的 `bmp_route_identities.prefix` 保存 parser 生成的可读标识，Route Lens 用它做从头匹配，例如：

- EVPN：`evpn:mac-ip:65000:41:tag=141:mac=aa:bb:cc:dd:ee:29:ip=192.0.2.51`
- BGP-LS：`bgp-ls:Link:10.250.0.1->10.250.0.2`
- FlowSpec：`dst=198.18.253.0/24; proto = 6; dst-port = 443`

复杂 NLRI 的 `prefix_length` 是 parser 长度元数据，不是 CIDR Mask，页面不会把它拼成 `/Mask`。

## 1. 数据库定位

SQLite 是 BMP RIB 的权威数据源，不是可选的历史副本。

- 完整 current RIB 和 Statistics Report 保存在 SQLite；不保留路由事件历史。
- 内存只保留在线连接、协议解析上下文、scope 元数据、少量摘要和页面增量状态。
- BGP Session、Loc-RIB Instance 和路由页面可在 BMP Worker 重启后从 SQLite 恢复。
- 数据库无法打开或 Writer 失败时，BMP 会 fail-closed，暂停继续接收数据，避免内存状态领先于数据库。

数据库基本信息：

| 项目 | schema v14 的值 |
| --- | --- |
| 数据库文件 | 每个 client 一个 `userData/bmp/bmp.sqlite3.clients/<source_id>.sqlite3` |
| Schema version | `14`，保存在 `PRAGMA user_version` |
| 稳定键 schema version | `3`（source/scope/route 一起升版；固定顺序的规范化字符串哈希及 EVPN RFC 键字段，见 7.1） |
| 稳定键算法 | SHA-256 |
| Journal 模式 | WAL |
| 外键 | DDL 中声明，但连接上 `foreign_keys = OFF`（引用完整性由 Writer 保证；`PRAGMA foreign_key_check` 仍可校验） |
| 同步级别 | `synchronous = NORMAL`（WAL 下保持数据库一致性；操作系统崩溃/断电仍可能丢失最近已提交事务，需设备重新上报） |
| Busy timeout | 5000 ms |
| 临时存储 | MEMORY |
| Writer 页缓存 | 64 MiB（`cache_size = -65536`） |
| Reader mmap | 256 MiB（`mmap_size`，只读连接） |
| WAL 自动 checkpoint | 每 client 预算 256 MiB；按实际 `page_size` 换算页数，默认 4 KiB 页为 65,536 页 |

WAL 模式运行时，数据库目录还可能存在：

- `<source_id>.sqlite3-wal`：该 client 尚未 checkpoint 回主文件的已提交 WAL 页面。
- `<source_id>.sqlite3-shm`：该 client 的 WAL 共享内存索引。

256 MiB 是自动 passive checkpoint 的触发预算，不是 WAL 文件硬上限。长读事务可 pin 住旧 WAL 页面，导致 checkpoint 无法回收全部页面；WAL 文件也可能保留已复用的空间。`NORMAL` 不在每次提交时同步 WAL，而在 checkpoint 等边界同步；正常停止另执行 passive checkpoint，不能将这项设置解释为断电后最近提交绝不丢失。

## 2. Schema v14 的核心变化

v10~v14 保留 v9 的固定分区和库内全局对象去重，重点是为“大量邻居同时全表上报”这类写入场景瘦身并保持路径隔离：

1. current route 固定拆成 `2 × 18 = 36` 张物理分区表（同 v9）。
2. Route identity/NLRI、扩展展示 payload 和 path attributes 分开全局去重，分区表只保留当前路径状态和外键（同 v9）。
3. `bmp_sources`、`bmp_connections`、`bmp_rib_scopes`、`bmp_route_attributes` 改为 rowid 表并暴露整数代理键 `source_pk`、`connection_pk`、`scope_pk`、`attr_pk`；current 分区和 `bmp_scope_route_counts` 只引用这些整数键，hex/UUID ID 仅在维表出现一次。
4. 取消 `current_ref_count` / `event_ref_count` 和维护它们的 trigger。identity、payload、attributes 的回收改为“候选驱动”：删除或替换 current row 时把旧引用键记入持久表 `main.bmp_gc_candidates`，与对应修改在同一事务提交；sweep/清理/删除 Source 时用反连接删除已无任何引用的候选。写入热路径不再更新每个对象的引用计数。
5. **v11 删除了路由事件表 `bmp_route_events` 和整个路由历史/事件轨迹功能。** 数据库只保存 current RIB 投影和 Statistics Report；重放去重改由 `bmp_connections.last_sequence` 承担，current 行的版本保护改用 mutation 序号 `last_sequence`。
6. current 分区从 6 个二级索引精简到 5 个；`bmp_route_identities` 去掉冗余的 `route_key_json` 列和一个前缀索引。
7. Scope route counters 仍由 trigger 在事务内维护（同 v9）。
8. **v13** 稳定键算法升为 v2：`route_id` / `scope_id` 哈希固定顺序的规范化字符串而不是排序 JSON（见 7.1）；同一路由的判定语义不变，键值不同。同时 bmpWorker 侧按邻居缓存 scope 描述符、按属性对象缓存 attr JSON/哈希、按文本缓存前缀归一化，并在批次传输时只发送一份 source/scope/connection 描述符。
9. **v12** 去掉 `bmp_route_identities.route_identity_json`（碰撞检测只依赖 SHA-256），普通 IP 前缀的 `nlri_json` 不再落库（`nlri_json = NULL`，`nlri_flags` 记录可选键，读取时由拆列重建完全相同的对象）。
10. **写入攒批**：一个批次内 identity / payload / attribute 各按每 250 行批量预取已有主键，仅对缺失对象做多行 INSERT 并 RETURNING；不再对每条路由做单独维表 upsert。分析未开启时 announce 也不再读取旧行的完整投影，只探测被替换的 payload/attr 主键用于回收。
11. **v14** 稳定键升为 v3，EVPN RT1–RT5 按 RFC 路由键字段生成 identity；完整 NLRI 的非键字段/解析注解移入当前路径 payload，不再从共享 identity 恢复旧 label、ESI 或 Gateway。对象 GC 候选改为持久表，maintenance 每次只处理有界工作集，重开 Writer 不丢未处理候选。
12. 版本不匹配时不迁移：Writer 打开数据库发现 `user_version` 不等于 14（更旧、更新、或未版本化但非空），会删除全部已有对象并重建空库；read-only 连接拒绝不兼容版本。

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
| `bmp_gc_candidates` | 与释放引用的事务一起提交的待检查对象键；跨 Writer 重开保留 |
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

下表中的 `familyId`、family key 和 token 都是代码 manifest 元数据，不是 SQLite 表字段；真正持久化到 scope 和 current row 的只有 `partition_id`。表名也只由 manifest 在应用内解析。

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

`familyId` 是 manifest 中显式固定且全局唯一的稳定编号，不依赖数组顺序。当前 `partition_id` 按 `100 + familyId`（peer）或 `200 + familyId`（loc-rib）生成，并同时持久化在 scope 和 current route 中。已发布的 `familyId` 不得重编号或复用；不要从数组位置或外部输入自行推导分区，应始终使用 manifest。

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
| `source_pk` | INTEGER PK | 数据库内部整数键；connections、scopes 引用它 |
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
| `connection_pk` | INTEGER PK | 数据库内部整数键；scopes、current 分区、counters 引用它 |
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
| `scope_pk` | INTEGER PK | 数据库内部整数键；current 分区、counters 引用它 |
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

按 RFC 7854，BMP Peer Header 的 `A` 位只说明 UPDATE 使用 legacy 2-byte 还是 4-byte `AS_PATH` 编码，与 `L`（Pre/Post-policy）及 RFC 8671 的 `O`（Adj-RIB-In/Out）正交；它不是独立 RIB stage。Peer 摄入只由 `L + O` 生成 `1/2/4/5`，Loc-RIB 单独按其协议规则解析。

DDL 只对 `scope_kind` 声明枚举 `CHECK`。上述 `rib_type` 值和 `scope_state` 状态机由应用写入逻辑保证，表本身没有对应枚举 CHECK。

## 7. 全局路由对象

### 7.1 `bmp_route_identities`

该表保存“这是什么路由”，在同一 client 内跨 scope 和 RIB stage 复用，不跨 client 复用。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `route_pk` | INTEGER PK | 数据库内部短键，供 current 分区引用 |
| `route_id` | TEXT NOT NULL UNIQUE | Canonical route identity 的稳定 SHA-256 ID |
| `route_key_version` | INTEGER NOT NULL | Route key schema version |
| `legacy_route_key` | TEXT NULL | 完整 NLRI lookup key；列名沿用现有结构，不表示旧 key 兼容 |
| `afi` | INTEGER NOT NULL | Address Family Identifier，也是分区验证依据 |
| `safi` | INTEGER NOT NULL | Subsequent Address Family Identifier，也是分区验证依据 |
| `path_id` | INTEGER NOT NULL | ADD-PATH Path Identifier |
| `rd` | TEXT NULL | VPN、EVPN、BGP-LS VPN 等 RD |
| `prefix` | TEXT NULL | 可索引的 IP 前缀或 parser 生成的复杂 NLRI 语义标识 |
| `prefix_length` | INTEGER NULL | IP 时是前缀长度；复杂 NLRI 时可能是协议编码长度，不能当作 CIDR Mask |
| `nlri_kind` | TEXT NULL | `ip-prefix`、`vpn-prefix`、`evpn`、`raw-nlri` 等 |
| `nlri_json` | TEXT NULL | 当前摄入写 `NULL`；完整路径 NLRI 放入 payload 的 `nlriDetail`，普通 IP 则由拆列重建 |
| `nlri_flags` | INTEGER NOT NULL，DEFAULT `0` | `nlri_json` 为 `NULL` 时记录可选键：bit0 = `valid: true`，bit1 = 含 `rd` |
| `first_seen_ms` | INTEGER NOT NULL | Identity 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Identity 最近使用时间；仅供诊断，不再参与 GC |

页面返回的 `canonicalRouteKey`（`{schemaVersion, algorithm, keyHex}`）由 `route_key_version` 和 `route_id` 在读取时重建，不再单独存 `route_key_json`。

普通 IP 的 `prefix` 按地址族和 `prefix_length` 规范化为网络地址文本，避免等价 IPv6 因零段压缩方式不同而精确查询漏项。旧 schema 不在当前版本内迁移或兼容（见第 16 节）。

`route_id` 的 canonical identity 包含 AFI、SAFI、ADD-PATH `path_id` 和规范化 NLRI。当前哈希输入是一条固定顺序的规范化字符串（`bmp-route|3|afi|safi|pathId|kind|…`，字段间用 U+001F 分隔）：IP/VPN/QP 前缀用网络地址 hex + 长度（VPN 另加规范化 RD），FlowSpec / BGP-LS / MVPN 等带原始字节的 NLRI 用 `routeType|rd|rawNlriHex`，EVPN 和其他结构化 NLRI 用规范字段的排序 JSON。同一个 canonical route 在多个 peer、RIB stage 或 Loc-RIB 中复用 identity；相同前缀但 `path_id` 不同则是不同 identity。v3 同时用于 source、scope 的键域，三类 ID 的哈希值均不同于旧版本，不承诺跨键版本复用。

QP NLRI 可以只携带前缀、没有 DQPN TLV；其 canonical identity 将 `dqpn/dqpnBits` 明确记为 `null/null`，与显式编码的 `0/0` 区分，允许两条路径分别保存和撤销。携带 DQPN 时，数值与位长必须同时存在并通过支持范围校验。

EVPN RT1–RT5 的键字段按 RFC 7432 和 RFC 9136 区分：

| Route Type | NLRI 键字段（此外共同包含 AFI/SAFI、Path ID） | 不参与路由键的路径字段 |
| --- | --- | --- |
| RT1 Ethernet Auto-Discovery | RD、ESI、Ethernet Tag ID | Label |
| RT2 MAC/IP Advertisement | RD、Ethernet Tag ID、MAC 长度/地址、IP 长度/地址 | ESI、一个或两个 Label、编码长度 |
| RT3 Inclusive Multicast | RD、Ethernet Tag ID、Originating Router IP 长度/地址 | 由 path attributes 补充的 Label/PMSI/封装信息 |
| RT4 Ethernet Segment | RD、ESI、Originating Router IP 长度/地址 | 展示/解析注解 |
| RT5 IP Prefix | RD、Ethernet Tag ID、IP Prefix 长度和规范化网络地址 | ESI、Gateway IP、Label、编码长度 |

不能统一从所有 EVPN route type 删除 ESI：RT1/RT4 的 ESI 是键，RT2/RT5 的 ESI 不是键。非键字段、原始编码、Label、warnings 等保存在每条路径的 payload `nlriDetail`；它们变化时更新当前路径，不新增 canonical route identity，也不会覆盖其他 scope 的路径详情。

索引：

- `(prefix, prefix_length, route_pk)`：精确前缀/前缀范围反查；AFI/SAFI 由展开行或分区选择过滤，不再单独维护带 AFI/SAFI 前导列的第二个前缀索引。
- `(legacy_route_key, route_pk)`：当前完整 routeKey 查询，结合 source 和 scope 唯一定位路由。

### 7.2 `bmp_route_payloads`

该表不是完整 route snapshot，只保存路径 NLRI 详情和无法从 identity、Path Attributes 或 current-state 重建的扩展字段。写入前删除 route key、AFI/SAFI、prefix、RD、path ID 等可重建顶层字段，删除可从 `bmp_route_attributes` 取得的属性字段，删除 route state、epoch 和 stale 时间等 current-state 字段，并省略空值、空集合及可重建的默认值。完整复杂 NLRI 及非键注解保留在 `nlriDetail`；只有普通 IP NLRI 的内容与 identity 拆列完全一致时才省略它。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `payload_id` | INTEGER PK | 数据库内部短键 |
| `payload_hash` | BLOB NOT NULL UNIQUE | `route_json` 的 SHA-256 二进制内容哈希 |
| `route_json` | TEXT NOT NULL | 仅含扩展展示字段的 JSON object；允许为 `{}` |
| `first_seen_ms` | INTEGER NOT NULL | Payload 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Payload 最近使用时间 |

内容相同的 payload 在不同 route identity、scope 和刷新之间共享一行。普通 IP prefix 路由如果没有额外展示字段，payload 就是 `{}`；所有这类 current row 可以引用同一个 `payload_id`。相同 canonical NLRI 在不同 peer/stage 上的 Label、Gateway、ESI 或解析注解不同时，分别引用不同 payload。

### 7.3 `bmp_route_attributes`

该表保存 canonicalized BGP Path Attributes。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `attr_pk` | INTEGER PK | 数据库内部整数键；current 分区引用它 |
| `attr_id` | TEXT NOT NULL UNIQUE | Canonical attribute JSON 的 SHA-256 ID |
| `attr_json` | TEXT NOT NULL | 去重后的属性 JSON |
| `first_seen_ms` | INTEGER NOT NULL | Attribute 首次使用时间 |
| `last_seen_ms` | INTEGER NOT NULL | Attribute 最近使用时间 |

Identity、payload 和 attributes 分离后，route 更新属性时无需复制 NLRI；同一组属性也不会在数百万条 route 中重复保存。

当前 canonical `attr_json` 由应用写入的顶层字段是 `origin`、`asPath`、`med`、`localPref`、`communities`、`otc`、`nextHop` 和 `prefixSid`。这些是 JSON 内部字段，不是 SQLite 独立列；按 Next Hop 或 AS Path 搜索时需要解析/搜索 `attr_json`，页面读取则一次解析后覆盖到路由投影。

读取 current route 时，应用按以下来源重建 route 投影：

1. `bmp_route_identities` 的 AFI/SAFI、prefix、RD、path ID 构造基础字段；普通 IP 的 NLRI 由拆列和 `nlri_flags` 重建。
2. `bmp_route_payloads.route_json.nlriDetail` 提供当前路径的完整 NLRI，其他 payload 字段叠加扩展展示值；`{}` 不影响基础投影。
3. `bmp_route_attributes.attr_json` 叠加 canonical BGP Path Attributes，再由关联到的 `bmp_route_attributes.attr_id` 恢复 `attrId`。
4. 从物理分区、scope 和 connection 补充 `routeState`、epoch、stale 原因和观察时间。

### 7.4 对象回收（候选驱动 GC）

v10 起不再维护引用计数。identity、payload 和 attributes 的生命周期规则是：**只要还有任何 current row 引用它，就保留；否则可以删除。**

回收由释放或未建立 current 引用的操作驱动：

| 动作 | 记录的候选 |
| --- | --- |
| Withdraw / purge 删除 current row（`DELETE ... RETURNING`） | 被删 current row 的 `route_pk`、`payload_id`、`attr_pk` |
| Announce 替换了已有 current row 的 payload/attribute | 旧的 `payload_id`、`attr_pk` |
| Sweep 删除旧 epoch/旧连接/过期 stale 的 current row | 被删 current row 的 `route_pk`、`payload_id`、`attr_pk` |
| 手动清理 stale 路由、删除 Source | 同上 |
| 路由对象预填充后 mutation 被序号、connection 或 epoch 守卫拒绝 | 未成为 current 引用的预填充对象键 |

候选先写入持久表 `main.bmp_gc_candidates(kind, pk)`，与释放/拒绝引用的 mutation 在同一事务提交。`kind` 为 1（identity）、2（payload）或 3（attribute），`pk` 为对应对象的整数主键；复合主键 `(kind, pk)` 自动去重，不保存完整路由。

maintenance 在事务内按 `kind, pk` 取最多 `auxiliaryLimit` 条候选放入 `temp.bmp_gc_work`，再执行三条反连接删除，例如：

```sql
DELETE FROM bmp_route_attributes
 WHERE attr_pk IN (SELECT pk FROM temp.bmp_gc_work WHERE kind = 3)
   AND NOT EXISTS (SELECT 1 FROM bmp_current_route_refs c WHERE c.attr_pk = bmp_route_attributes.attr_pk);
```

反连接走每张分区的 `attr` / `payload` / `route` 索引，因此代价与候选数成正比，而不是与全表大小成正比。

Announce/withdraw 的热路径只把键写入持久候选表，不执行反连接；真正的删除在 maintenance sweep、手动清理 stale 路由和删除 Source 时进行。已检查的候选从主表删除，临时工作表随后清空；仍被任何 current row 引用的对象保留，将来再次释放引用时会重新登记候选。候选与对象删除在同一事务内处理，失败会一起回滚。

maintenance 的 `auxiliaryLimit` 默认 5000、上限 50000，每次只检查该有界工作集；未处理候选留在主表，`hasMore` 促使后续维护继续。Writer 关闭、缓存驱逐或 collector 重启不丢候选。手动 stale 清理也在删除事务内处理 GC，但使用独立 `gcLimit`，默认 2000、上限 50000；历史 replace/withdraw 留下的候选不能使一次小批量清理变成无界事务。剩余候选由 maintenance 继续处理。单 client 清空仍执行该库所需的完整 GC。

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

`(scope_pk, partition_id)` 对 scope 声明 `ON DELETE CASCADE`，但 Writer 的 `foreign_keys = OFF` 不执行该级联。应用删除 scope/source 前显式删除所属 current 分区行，分区 delete trigger 同步减少 counter。

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

同一 client 批次中的 source、connection、scope、库内路由对象、current projection、counter、连接序号和 statistics 修改在一个 SQLite transaction 中提交。包含多个 client 的传输批次先按 client 拆开，各库独立提交，不承诺跨库原子事务；重试依靠各库的 `batch_id` 幂等记录。若重试涉及已提交子批次，Route Assurance 会失效并重新读取已提交状态，避免遗漏首次提交的增量。

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
   │    ├─ canonical identity（普通 IP NLRI 可由拆列重建）
   │    ├─ 每路径 NLRI 详情及扩展 payload（普通路由可为 {}）
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
4. 同一 `(scope_pk, route_pk)` 已存在时先比较 payload、attribute、connection、epoch 和显式状态。全部相同且仍为 active 时，只更新 `last_seen_ms`、`source_timestamp_ms` 和 `last_sequence`，保持首次观察时间不变，不改未变的索引列。只有确实替换了 payload/attribute 引用，才把对应旧引用记入 GC 候选。
5. 新增、属性/payload 变化、连接/epoch 切换和状态变化仍走完整 UPSERT，开启分析时构造 committed delta。纯时间/顺序刷新不构造业务增量；source 或 scope 的分析上下文变化则要求重建分析快照，避免未重新上报的路由仍使用旧上下文。该分类不再落库。

### 13.1.1 重复上报优化与测量

真实解析路径在同一个 UPDATE 内按地址族及有效 Next Hop 共享不可变属性对象，公共 AS_PATH、Community 等只提取一次，属性 JSON/哈希只生成一次；经典 IPv4 的 NEXT_HOP 不与其他地址族的 MP_REACH Next Hop 混用。每条路由的 NLRI、Path ID、Label、Path Marking 和 Route TLV 仍独立，外部属性修改采用 copy-on-write，不影响共享该对象的其他路由。这不是跨 client 共享属性，也不会跳过报文解析。

数据库快速刷新只适用于同内容、同连接和同 epoch 的已存在路由。它仍保存最近观察时间、设备时间及新 sequence，仍检查 scope 所属连接和 epoch；重连刷新、EOR 清理、撤销和旧序号保护保持原语义。持久化本身不意味着重复报文不再处理，不能把旧 `batch_id` 重试的幂等短路当作正常重复上报的性能。

纯路由 upsert 批次还会按 partition/scope 每 250 个路由键批量预取 current 行的整数引用和状态，避免每条路由单独跨 native 边界查询。缓存只存在于当前事务/批次，明确区分“已查不存在”和“未预取”；同一路由在批内多次出现时，只有成功写入才同步缓存，仍按原 FIFO 顺序执行。含 EOR、撤销或其他生命周期事件的混合批次保留逐条查询路径，不跨批持有完整路由缓存，也不提前修改 scope 或执行生命周期操作。

解析侧按 session/owner 共享冻结的 source、connection 和 scope 描述对象；元数据、端点、VRF、状态或 epoch 变化时创建新对象，已排队的 mutation 不会被后续修改污染。缓存位于模块 WeakMap，不进入会话快照，不跨 client 共享状态。Worker 的结构化复制会保留批内共享引用；中转线程不再对纯路由 DTO 二次深拷贝，事件及统计中的 Buffer 等仍正常恢复。持久化 transport 对完整描述内容进行去重，而不是仅按 ID 合并；Writer 只对同一个描述对象做一次规范化、scope identity 解析和 source 绑定检查，仍先校验整批再写入任何 client。

维表预取先批量查询已有 identity/payload/attribute 的整数 PK，只有缺失对象才批量插入并 RETURNING；已存在对象不再执行 INSERT OR IGNORE，payload 哈希碰撞校验仍保留。纯 upsert、单一稳定 source/connection/scope 上下文且路由 key 不重复的批次，可以将同内容路由的观察元数据刷新推迟到事务内末尾，每 250 行执行一次 guarded UPDATE。完整语义变更仍按原路径执行；存在同 key 重复、上下文切换或生命周期事件时禁用推迟刷新，保留 FIFO 逐条处理。批量 UPDATE 再次检查 payload/attribute、connection/epoch、active 状态、行序号及 scope 实际 owner/epoch，随后才提交 connection 高水位；任何错误回滚整批。5000 条符合条件的重复路由可由 5000 次单行刷新降为 20 次批量刷新，但仍保存每条路由的观察时间和序号，并非丢弃重复报文。

批量 SQL 必须由刷新记录驱动：先使用 `(scope_pk, route_pk)` 唯一索引取得符合上述守卫的 `path_pk`，再按 current 表的整数主键更新。不能仅按 scope/connection/epoch 范围扫描后再与 250 条记录关联，否则在百万行 scope 上会严重退化。回归测试同时断言执行计划中的唯一索引双列定点查找、目标行主键查找和持久索引/计数触发器不被改写，防止“SQL 调用少但扫描量更大”的回归。

可重复的端到端基准使用一个 peer 或一个 Loc-RIB 实例、独立全新临时库、固定线程与批量配置，计时从 TCP 发送开始直到末尾独特标记路由提交。首次和重复上报使用完全相同的报文字节，但接收时间及内部 sequence 都是新值；每轮校验准确路由条数、首/中/末路由属性和最近观察时间。报文构造与校验不计入写入耗时。

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/bmp_repeated_ingest_benchmark.js \
  --routes=1000000 --rounds=3 --label=baseline --output=/tmp/bmp-baseline.json
# 修改优化代码后，在没有其他压测的情况下使用相同命令参数复测。
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/bmp_repeated_ingest_benchmark.js \
  --routes=1000000 --rounds=3 --label=optimized --output=/tmp/bmp-optimized.json
node scripts/benchmarks/compare_bmp_repeated_ingest_benchmarks.js \
  /tmp/bmp-baseline.json /tmp/bmp-optimized.json /tmp/bmp-comparison.json
```

默认每个 UPDATE 含 50 条 IPv4 /24 NLRI，共 100 组属性，使用 1 个解析 Worker 和 1 个 Writer、5000 条攒批、20 ms flush，关闭 Route Assurance；peer 和 Loc-RIB 各跑 3 轮，并交替测试顺序。比较工具会检查配置、硬件/运行时、报文 SHA-256 和基准脚本哈希一致，再计算耗时下降和吞吐提升。数据库及原始结果保留在新建临时目录，不读取或修改应用数据库；较小的同路径回归见 `test/ci/bmp_repeated_ingest_tcp.js`。

2026-10-02 在 Apple M4 Pro / macOS arm64 / Electron 22.3.27 上，以每种 scope 100 万条路由实测。下表为三轮中位数；优化前指已经支持属性共享和 current 引用批量预取的上一版，优化后增加上述描述对象复用、缺失维表插入和定点批量刷新。优化前另做一轮复测，确认核心文件哈希、报文、配置与运行时和三轮基线一致；优化后也校验被测文件哈希与交付代码一致。

| Scope | 上报 | 优化前 | 优化后 | 耗时下降 |
| --- | --- | ---: | ---: | ---: |
| Peer | 首次 | 31.315 s | 23.399 s | 25.28% |
| Peer | 重复 | 20.510 s | 10.267 s | 49.94% |
| Loc-RIB | 首次 | 31.389 s | 24.653 s | 21.46% |
| Loc-RIB | 重复 | 22.260 s | 11.965 s | 46.25% |

这是 TCP 接收到落库的端到端结果，不是 SQL 微基准，也不包含 UI 或 Route Assurance 分析耗时。百万次 NLRI 解析、路由键生成、消息传输和逐行观察元数据持久化仍然存在，因此不代表重复上报可以完全跳过处理。EVPN、IPv4/IPv6 FlowSpec 的快路径与语义变化回退由 `test/ci/bmp_non_ip_bulk_refresh.js` 另行验证；未知 AF/SAFI 保留 raw NLRI，不宣称已经解析 VPN FlowSpec。

### 13.1.2 协议与存储安全修复的百万路由门禁

2026-10-03 在同一 Apple M4 Pro / macOS arm64 / Electron 22.3.27 上，将基线提交 `96fa271` 与本轮协议/存储安全修复比较。两边使用同一份合法 mock 报文（Sent OPEN 在 Received OPEN 前，BMP A=0 的 AS_PATH 为四字节 ASN），并校验报文字节 SHA-256、配置、基准脚本和运行时一致。每种 scope 100 万条路由，各执行 3 轮独立新库，以下为中位数：

| Scope | 上报 | 基线 | 修复后 | 耗时下降 |
| --- | --- | ---: | ---: | ---: |
| Peer | 首次 | 22.988 s | 22.278 s | 3.09% |
| Peer | 重复 | 10.034 s | 9.659 s | 3.74% |
| Loc-RIB | 首次 | 24.814 s | 23.758 s | 4.26% |
| Loc-RIB | 重复 | 11.972 s | 11.591 s | 3.18% |

配置为 1 个解析 Worker、1 个 Writer、5000 条攒批、20 ms flush、每 UPDATE 50 条 NLRI、100 组属性，关闭 Route Assurance。计时从 loopback TCP 发送开始，到末尾独特 marker 路由实际提交；报文构造、UI 和 Route Assurance 分析耗时不计入。修复后包含 `WAL + synchronous=NORMAL`、256 MiB 自动 checkpoint 预算、持久 GC 候选、完整 `routeKey` 和协议/路径详情校验，并非单项 SQL 微基准。普通 IP lookup key 直接复用已计算的 canonical prefix；EVPN/结构化 NLRI 复用已排序的 canonical JSON，不新增第二次 hash 或排序。最终三轮测量校验核心源码哈希与交付源码一致。这组结果验证本轮修复在该可重复的百万 IPv4 路由路径中没有性能退化，不外推其他地址族、磁盘或真实设备的具体吞吐。

本轮修复后的最终测量已固定为版本化基线：[bmp_repeated_ingest_1m_m4pro_20261003.json](https://github.com/jihuaib/NetNexus/blob/master/scripts/benchmarks/baselines/bmp_repeated_ingest_1m_m4pro_20261003.json)。文件保留全部 12 次首次/重复上报样本、四组中位数、fixture 字节数与 SHA-256、测量配置、硬件/运行时、方法及采集当时的源码指纹，仅移除个人临时数据库目录。源码指纹是历史采集信息，不会为了匹配后续源码而重写。

在同一硬件/运行时、相同 fixture/configuration/基准脚本下复测后，可使用固定入口比较，不需要重新选择基线文件：

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/bmp_repeated_ingest_benchmark.js \
  --routes=1000000 --rounds=3 --label=candidate --output=/tmp/bmp-candidate.json
node scripts/benchmarks/compare_bmp_repeated_ingest_baseline.js \
  /tmp/bmp-candidate.json /tmp/bmp-baseline-comparison.json
```

固定入口委托现有比较工具，配置、报文哈希、基准脚本或运行时不一致时拒绝比较。轻量 CI `bmp_repeated_ingest_baseline.js` 只检查历史报告完整性、样本/统计一致性和比较入口，不执行百万压测，也不把四组历史耗时当作跨机器阈值或自行增加百分比门禁。后续实现优化应保留此基线；只有明确变更测量协议、fixture、配置或硬件/运行时时，才重新执行同规格三轮实测、校验源码与采集指纹，并新增带日期的基线及更新入口，不能覆盖旧样本或伪改哈希。

### 13.1.3 2026-10-05 全流程 review 修复与回归

本轮修复覆盖接收、协议状态、持久化、路由分析和页面刷新，沿用 schema v14 和现有分库布局。Writer 异常即使发生在没有在线 client 时，也会通知运行状态、关闭监听器及解析/读写 Worker，再退出协议进程；监听端口占用会返回启动失败，运行中的 listener 异常也走统一停止流程。监听器和认证 helper 的并发关闭复用同一个 promise，退出前等待清理完成。

协议侧拒绝缺失、截断或结构不完整的 Peer Down 和 Statistics Report，保留之前的有效状态/统计；完整未知统计类型仍保存原始字节。Loc-RIB 各地址族拥有独立 Add-Path 协商 Map，更新一个地址族不会清空另一个地址族。两字节 ASN 的兼容报文按 AS_PATH/AS4_PATH 重建有效路径，并保留 `wireAsPath`、`as4Path` 供详情检查；不含 AS4_PATH 的普通四字节 ASN 报文不增加这些可选属性字段。已丢失 AS4 信息的历史记录需重新上报才能补齐。

持久化在写 source/connection 元数据前检查 sequence，已拒绝的旧 mutation 不会覆盖新设备描述或连接端点。进度复用当前 batch 的 connection cache，每个连接每批只增加一次索引读取，不为每条路由增加 SQL 查询。手动 stale 清理的对象 GC 使用独立有界预算，剩余候选持久保存并由 maintenance 回收（见 7.4、13.4），不再因历史候选积压扩大一次小批量删除事务。

路由分析修正数字地址族筛选；Community 按集合语义比较，Label 栈及 AS_PATH 保持顺序语义。流式分析的截断明细仍保持证据计数准确，分页按实际保留的明细数计算，多出口证据和属性差异输出也有上限；截断 peer、属性值或多路径样本时仍保留能证明差异的值，避免可见证据全部相同。Route Lens 和 Route Assurance 页面采用固定刷新窗口，持续事件不会反复推迟定时器；查询期间的新事件合并成一次后续刷新，并在离开页面时取消。

回归覆盖以下行为，88 个 BMP CI 脚本、6 个浏览器 E2E 用例及前端生产构建全部通过；新增 CI 用例由现有 runner 自动发现。运行记录见 [validation.json](../scripts/benchmarks/reports/bmp_review_20261005/validation.json)：

| 用例 | 验证重点 |
| --- | --- |
| `bmp_runtime_failure.js` | 空闲 Writer 异常完整停止、端口占用失败后重试、运行中 listener 异常、退出等待 helper 清理、重复故障只通知一次 |
| `bmp_protocol_review_regressions.js` | BMPv3/v4 非法生命周期和统计不产生 mutation、多地址族 Add-Path 隔离、AS4 重建及 SQLite 往返 |
| `bmp_persistence_storage_regressions.js`、`bmp_persistence_bulk_refresh.js` | 跨批/批内 replay 不回退元数据、1000 条同连接路由只读一次 sequence、批量刷新守卫与回滚 |
| `bmp_manual_stale_purge_sqlite.js`、`bmp_persistence_storage_regressions.js` | 默认/显式 GC 预算、候选重开后保留、maintenance 最终回收、活跃/共享引用和另一 client 数据保持正确 |
| `bmp_route_analysis_regressions.js`、`bmp_monitor_ui_lifecycle.js` | 地址族及属性比较、截断证据增量计数/分页/输出上限、持续事件和查询期间事件刷新、页面离开取消 |

最终分析实现还通过百万路径性能用例：首次聚合 5292.4 ms，缓存分页 0.2 ms、分类分页 0.1 ms，保留堆 400.7 MiB、峰值 RSS 775.6 MiB。仍沿用原来的 15 s / 100 ms / 512 MiB / 1536 MiB 预算，未放宽阈值；缓存翻页不重新扫描 RIB，新增增量回归也禁止遍历全部 run records。

同一会话在 Apple M4 Pro / macOS arm64 / Electron 22.3.27 上分别运行修复前后代码，peer 和 Loc-RIB 各 100 万条路由、各 3 轮独立新库。使用与 13.1.2 相同的 1 个解析 Worker、1 个 Writer、5000 条攒批、20 ms flush、每 UPDATE 50 条 NLRI 和 100 组属性，关闭 Route Assurance；fixture、配置、基准脚本及运行时一致。计时仍从 loopback TCP 发送到末尾独特 marker 路由提交，以下为三轮中位数：

| Scope | 上报 | 同会话修复前 | 本次修复后 | 相对同会话耗时下降 | 相对 2026-10-03 固定基线耗时变化 |
| --- | --- | ---: | ---: | ---: | ---: |
| Peer | 首次 | 22.663775 s | 22.604033 s | 0.26% | +1.46% |
| Peer | 重复 | 9.779913 s | 9.671867 s | 1.10% | +0.13% |
| Loc-RIB | 首次 | 24.479772 s | 23.660635 s | 3.35% | -0.41% |
| Loc-RIB | 重复 | 11.904294 s | 11.615164 s | 2.43% | +0.21% |

同会话四组中位数均低于修复前；相对固定历史基线则有三组略慢、一组略快，不能宣称所有项目都比历史测量更快。这是当前硬件、fixture 和关闭分析的百万 IPv4 路径实测，不构成其他地址族、磁盘、并发 client 或 UI/分析耗时的保证，也不将小幅差异解释为统计显著的吞吐提升。

原始样本和源码指纹保留在 [before.json](../scripts/benchmarks/reports/bmp_review_20261005/before.json)、[after.json](../scripts/benchmarks/reports/bmp_review_20261005/after.json)，同会话比较见 [before_after.json](../scripts/benchmarks/reports/bmp_review_20261005/before_after.json)，固定历史基线比较见 [historical_comparison.json](../scripts/benchmarks/reports/bmp_review_20261005/historical_comparison.json)。13.1.2 的历史报告、原始基准脚本和固定基线保持原采集内容。

### 13.2 Withdraw

1. 规范化完整 NLRI，定位已有 route identity 和 current path；未知路由不新增 identity、payload 或 attributes。
2. 只有 connection 和 epoch 仍有效时，才从目标分区删除 current row。
3. Trigger 自动减少 scope count；被撤销路由的 identity/payload/attributes 记入 GC 候选，等待下一次 maintenance sweep 回收。
4. 旧 connection 或错误 epoch 不删除 current row，delta 分类为 `withdraw-noop`。

### 13.3 EOR 和旧 epoch

同一 BMP 连接内，重复上报某 AF 的 Peer Up（该 AF 的新一轮刷新）会推进该 AF scope 的 `current_epoch` 并进入 `syncing`；分批 Peer Up 中首次出现的新 AF 只打开自身 scope，不影响已经存在的其他 AF。Peer Down 已推进全部已跟踪 scope 的 epoch，因此其后的首个 Peer Up 复用该 epoch，不重复推进。若普通 peer 的 Peer Down reason 1/3 携带结构完整的 BGP Notification，旧 epoch 路由会立即从 current projection 删除（delta 原因为 `peer-down-notification:<reason>`）；其他 Peer Down 仍保留 stale 路由等待刷新、撤销或 sweep。EOR 将精确的 AF/RIB scope 设为 `ready`，记录 `eor_epoch` 并设置 `cleanup_pending_epoch`。

旧 connection/epoch 路径在删除前通过有效状态公式显示为 stale。Sweep 从 scope 对应的单一分区中分批删除旧路径，避免全库大事务。

如果新连接已经用 Peer Up 打开 scope、但一直没有 EOR，refresh timeout 到期后只保留该连接实际重新上报的路径，并删除旧 connection/epoch 路径。若同一设备重连后某个历史 scope 连 Peer Up 都没有再次出现，Collector 在确认该 source 只有一个更高代的在线连接后，也从新连接建立时间开始使用同一 refresh timeout 清空该 scope 的旧路径；scope 仍保持 `down`，不会伪装为在线或 `ready`。同一 source 存在多个并发在线连接时不执行这项整 scope 清理，避免不同 feed 互相删除。

### 13.4 手动清理过期路由

Peer 和 Loc-RIB 的“清理过期”只作用于选定的 `source_id + scope_id`，不随前缀搜索条件扩大或缩小范围。Client 断线但 BMP 服务仍运行时可以清理；BMP 服务未启动时返回明确错误，不再报告“成功删除 0 条”。

清理开始前先等待该 source 的解析 FIFO，再等待其 Writer lane 的已排队 mutation。身份尚未从 Initiation 解析结果同步到协调线程的连接也等待解析 barrier，避免遗漏目标设备的重连报文。其余已知 source 的解析线程不参与等待，也不再向所有 Writer 广播清理请求。后续每批最多删除 20,000 条，批间可继续处理新上报；不反复建立全局写入屏障。

手动清理使用 `includeDetails: false` 的轻量路径：

1. 用 `bmp_scope_route_counts` 定位有效状态为 stale 的 connection/epoch/state 桶，而不是每批从 scope 的正常路由头部重新过滤。
2. 经目标分区的 `scope_epoch` 索引选择窄引用键，放入 `temp.bmp_stale_purge_candidates`；这是本批删除工作集，不是持久对象 GC 候选表。不读取 payload、属性或 NLRI JSON，不构造逐路由 `routes/deltas`。
3. 在同一事务内重新检查物理路径、引用键和有效 stale 状态，集合式登记 GC 候选、删除 current rows。计数 trigger 仍正常执行，共享 identity/payload/attributes 仍按所有分区的实际引用回收；异常时整个批次回滚。
4. 只返回删除数量、是否还有 stale 路由候选和受影响的 scopes。`hasMore` 不表示对象 GC 候选已经清空；每批默认最多处理 2000 个对象候选，剩余工作由 maintenance 继续处理。每个已提交批次广播 scope 刷新事件；页面通过现有节流刷新读取最新已提交数量。

同一 source/scope 的后台任务互斥，前端立即显示“清理中”并禁止重复提交。切换 Client、AF、RIB 或实例不会把旧任务的完成/失败状态写到新范围。服务停止或运行实例改变时取消后续批次，已提交批次不会回滚；失败展示具体后台原因并释放清理状态。

Route Assurance 开启时，手动批量删除使投影失效，清理完成后从已提交的 RIB 重建，不传输百万条删除路由。清理期间不会反复启动全 RIB 重建。其他逐路由增量若返回“需要重建”（例如流式分组队列溢出），协调线程也会执行失效/重建，不能继续使用旧矩阵。

这条路径不修改 schema，也不执行 `VACUUM`；删除释放的 SQLite 页可被后续写入复用，数据库文件不保证立即变小。带完整路由详情的清理仍用于需要逐路由删除增量的调用。

性能对比脚本：

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --expose-gc \
  scripts/benchmarks/bmp_stale_purge_benchmark.js --routes=1000000 --rounds=3
```

脚本使用独立临时合成数据库，对相同 seed 的副本比较原详细清理和新手动批量清理。建库不计时，结果是 SQLite Store 清理耗时，不包含 TCP、线程消息传输、界面渲染或 Route Assurance 最终重建。`--sparse` 可测试 90% 当前路由与 10% 旧 epoch 路由混合的情况；`--kind=peer` 或 `--kind=loc-rib` 可单独运行。

当前代码默认每批只处理最多 2000 个对象 GC 候选，原始脚本计时结束只要求 stale 路由为零，可能仍有候选等待 maintenance。这个默认结果反映路由删除延迟，不能直接用来宣称包含完整对象回收的清理更快。复测完整 GC 口径时，保留原始脚本并加载独立 adapter：

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --expose-gc \
  --require ./scripts/benchmarks/bmp_stale_purge_full_gc.js \
  scripts/benchmarks/bmp_stale_purge_benchmark.js --routes=1000000 --rounds=3
```

该 adapter 为详细路径和批量路径都设置 `gcLimit: 50000`。此合成 fixture 每批删除 20000 条、共享 payload/attributes，最多产生约 20002 个不同对象候选，因此这个预算包含该批完整回收；最后一批还断言候选表为空，identity、payload、attribute 都不存在无引用对象，断言计入测量时间。它只用于上述合成基准，不改变产品默认预算；已有大量历史 backlog 的应用库不具备相同上限假设。

2026-10-03 在 Apple M4 Pro、Electron 22.3.27 / Node 16.17.1 / SQLite 3.49.2 上，以每批 20,000 条、全部 stale、共享小 payload/属性的合成路由执行 3 轮，交替原路径/优化路径顺序，取中位数：

| 范围 | 过期路由数 | 原详细清理 | 新手动批量清理 | 耗时下降 |
| --- | ---: | ---: | ---: | ---: |
| Peer | 1,000,000 | 45.260 s | 5.932 s | 86.89% |
| Loc-RIB | 1,000,000 | 45.632 s | 6.003 s | 86.84% |

每次均完成 50 批，并验证无残留 stale 和外键异常。真实 Worker + 两个独立 client Writer 的集成测试另验证分批事件、当前活跃路由、其他 scope、另一 client 和共享对象保持正确；真实页面测试验证清理期间数量刷新及切换范围后的状态隔离。这些存储层数字不代表真实 BMP 报文或 UI 的端到端耗时，也不外推 EVPN/FlowSpec 的具体秒数。

2026-10-05 在同一环境分别用修复前后代码加载上述完整 GC adapter，对 Peer、Loc-RIB 各执行 3 轮百万路由清理，仍取中位数。这里“详细/批量”指两条 Store 清理路径，“修复前/后”指代码版本，两者不能混淆：

| Scope | 路径 | 同会话修复前 | 本次修复后 | 耗时变化 |
| --- | --- | ---: | ---: | ---: |
| Peer | 详细 | 45.495220 s | 45.433817 s | -0.13% |
| Peer | 批量 | 6.369531 s | 6.375678 s | +0.10% |
| Loc-RIB | 详细 | 45.276380 s | 45.661565 s | +0.85% |
| Loc-RIB | 批量 | 6.401598 s | 6.411073 s | +0.15% |

两组批量完整 GC 的修复前后样本范围重叠，没有把延后回收计作性能收益。相对 2026-10-03 文档中的批量历史值，修复后分别慢约 7.48% 和 6.80%；同会话修复前也分别慢约 7.38% 和 6.64%，因此需结合本次前后比较评估代码影响，不能宣称本次比历史值更快。上述小幅前后差异不作统计显著性结论。

每次均验证 stale 路由、GC 候选、无引用 identity/payload/attribute 和外键异常为零。12 个修复后原始样本见 [stale_full_gc.json](../scripts/benchmarks/reports/bmp_review_20261005/stale_full_gc.json)，12 个修复前样本见 [stale_full_gc_before.json](../scripts/benchmarks/reports/bmp_review_20261005/stale_full_gc_before.json)，包含范围和脚本/源码指纹的比较见 [stale_full_gc_comparison.json](../scripts/benchmarks/reports/bmp_review_20261005/stale_full_gc_comparison.json)。

### 13.5 入站路由提交后的页面刷新

收到路由事件不代表 SQLite Writer 已提交。Peer/Loc-RIB 页面通过只读 Reader 查询最新已提交快照，不等待整个写入队列清空；仅依赖接收通知时，最后一次查询可能只看到部分路由，后续入库没有新报文，页面便停在旧数量。

Writer 的成功批次回调同时传递原批次，Worker 从 interned source/connection/scope 描述符收集受影响范围，补发轻量刷新信号。首次上报、替换、重复 refresh、撤销及 scope open/stale/EOR/timeout 均覆盖，Route Assurance 关闭或批次重放时也不遗漏。信号不展开 route/payload/attributes，不查询全 RIB；`changedCount: 0` 避免重复计算接收阶段已经统计的路由数。

提交事件继续通过现有 1 秒 Worker 聚合和 1.5 秒页面节流，按 source/connection/scope 隔离；最后一批提交后仍会安排刷新，因此无需切换 tab 才能看到最终数量。失败批次不发送成功提交通知，旧运行实例和停止期间的回调不会重新启动刷新。页面查询保留 `fence: false`，避免大量上报时阻塞交互。

## 14. 定时 sweep 和引用对象 GC

Worker 默认周期性执行小批量 sweep：

1. 找到需要清理的 scope。
2. 根据 scope 的 `partition_id` 只访问对应 current-route 表。
3. 分批删除旧 epoch、旧 connection 或超过 stale 保留期的路径。
4. 清理未被 latest 引用的旧 statistics sample 和旧 ingest batch。
5. 从持久 GC 候选取有界工作集做反连接删除：仍被任何 current row 引用的对象保留，已检查的候选消费完毕，未处理候选继续保留（见 7.4）。

这里有两个不同的时间口径：

- Stale retention 只控制已经 stale/down 的 scope 路径老化；EOR 已确认的旧 epoch 可以立即进入清理，不必再等 24 小时。
- `eventsBeforeMs`（沿用旧参数名）是未被 latest 引用的 statistics sample 和旧 ingest batch 的清理 cutoff；identity/payload/attributes 没有独立的时间口径，失去最后一个引用后由持久候选驱动，在后续有界 maintenance sweep 中回收。

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

## 16. Schema v14 初始化和版本规则

v14 不做任何数据迁移，也不维护旧稳定键兼容映射。应用在创建窗口和业务模块之前，统一检查旧共享库及全部 client 库的 `PRAGMA user_version`。这是数据库 schema 版本检查，不是应用版本号检查：

| 情况 | 应用启动检查 | 离线 Read-only 打开 |
| --- | --- | --- |
| `user_version = 14` | 保留主库和附件 | 对象完整时直接使用；缺表/缺列则报错 |
| 其它可读取的 `user_version` | 删除该主库及其 `-wal`、`-shm`、`-journal`，不迁移 | 版本不兼容时报错，不创建 Writer |
| 主库不存在 | 不创建库，也不删除孤立附件 | 无客户端主库时返回数据库不存在 |
| 无法读取主库版本，或目标不是普通文件 | 明确失败，保留文件，不猜测或递归清理 | 报错，不清理 |

启动检查只因版本不同删除已识别的数据库文件组；同版本不会因应用升级或每次启动而删除。被删除的 client 库在设备重新连接后由 Writer 创建空 v14 库，current route 和 statistics 随 BMP 设备重新上报恢复。没有离线读取触发的写入初始化或数据迁移。

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

正常情况下这三个数字应接近 0；非零可能是已登记持久候选、等待后续 maintenance 的对象，也可能来自绕过 Writer 的手工操作。可先检查候选数并等待维护，不应仅凭短暂非零判断引用损坏：

```sql
SELECT kind, COUNT(*) AS pending_candidates
  FROM bmp_gc_candidates
 GROUP BY kind;
```

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
- 不要只备份某个 client 的主文件而忽略正在使用的 WAL/SHM。
- 最稳妥的离线备份方式是先停止 BMP，让队列 drain 并 checkpoint，再复制整个 `bmp.sqlite3.clients` 分库目录。
- 大量删除后文件不会自动缩小；`freelist_count` 表示可复用页，是否执行 `VACUUM` 应由运维窗口和可用磁盘空间决定。
- `bmp_current_routes_all` 是只读统一视图，不应作为写入目标。
- v14 没有旧 schema 或旧稳定键兼容层；应用启动统一按 SQLite `user_version` 检查旧共享库与 client 库，同版本保留，不同版本删除主库及三个标准附件，不迁移数据。需要保留旧版本数据时必须在启动应用之前备份；离线查询不会执行清理或升级。
